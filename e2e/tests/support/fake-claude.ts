import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InProcessClient, type SdkServer } from './fake-mcp.js'
import { askToDeploy, PERMISSION_INPUT, PERMISSION_PROMPT, type CanUseTool } from './fake-permission.js'
import { REPEAT_PROMPT, repeatBuild, type FakeHooks } from './fake-repeat.js'
import { sideChatQuery } from './fake-side-chat.js'
import { actSteps, gateOf, type StepActor } from './fake-steps.js'

/** What a prompt asks for to get a background shell from this fake. */
export const SHELL_PROMPT = 'start a background shell'
export const SHELL_COMMAND = 'echo "dev server listening on http://localhost:5173"; while true; do sleep 1; done'
export const SHELL_DESCRIPTION = 'Run the dev server'
/** What a prompt asks for to have the background shells stopped at their time limit. */
export const LIMIT_PROMPT = 'let the shells reach their time limit'
const LIMIT_SUMMARY = `Background command "${SHELL_DESCRIPTION}" was stopped after reaching its background time limit`
/** What a prompt asks for to get the text Seti appended to the system prompt as the reply. */
export const SYSTEM_PROMPT_PROMPT = 'show your system prompt'
/** What a prompt asks for to get the session id, with the one the process resumed, as the reply. */
export const SESSION_PROMPT = 'which session is this'
/** What a prompt asks for to get a turn that runs until it is interrupted or its process ends. */
export const HOLD_PROMPT = 'keep working until stopped'
/** The user row Claude Code writes when Query.interrupt cuts a turn short. */
const INTERRUPT_MARKER = '[Request interrupted by user]'
/** What a prompt asks for to get a turn that ends with ASK_REPLY, a question for the user. */
export const ASK_PROMPT = 'ask me which branch'
export const ASK_REPLY = 'The fix is ready on two branches.\n\nWhich one should I push?'

const plainReply = (prompt: string) => (prompt.includes(ASK_PROMPT) ? ASK_REPLY : 'Done.')

/**
 * A prompt that calls one tool of the session's seti MCP server, with its arguments as JSON;
 * with `hold` the turn then keeps working until stopped.
 */
export function setiPrompt(tool: string, args: Record<string, unknown> = {}, { hold = false } = {}): string {
  const call = `call seti ${tool} ${JSON.stringify(args)}`
  return hold ? `${HOLD_PROMPT}, then ${call}` : call
}
const SETI_CALL = /call seti ([\w-]+) (\{.*\})\s*$/s
/** The answer of a session whose seti server lacks the tool, as below the level it needs. */
export const NO_SETI_TOOLS = 'This session has no such seti tool.'

/** What a prompt asks for to have its first turn end the process with the given reason. */
export const FAIL_PROMPT = 'fail this turn with'
const FAIL_REASON = /fail this turn with (.+)$/
/** Prompts that failed once; the server keeps this module, so a retry of one succeeds. */
const failedOnce = new Set<string>()

type Message = Record<string, unknown> & { type: string }

interface UserMessage {
  message: { content: string | { type: string; text?: string }[] }
  uuid?: string
}

interface SpawnOptions {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string | undefined>
  signal: AbortSignal
}

interface Options {
  /** Seti's permission callback, which Claude Code calls for each call no rule allows. */
  canUseTool?: CanUseTool
  /** Seti's hooks, which Claude Code calls around each tool call. */
  hooks?: FakeHooks
  mcpServers?: Record<string, SdkServer>
  cwd?: string
  resume?: string
  /** A side chat forks the session instead of resuming it. */
  forkSession?: boolean
  tools?: string[]
  abortController?: AbortController
  env?: Record<string, string | undefined>
  systemPrompt?: { append?: string }
  /** Seti's launcher, which runs the stand-in in the agent's memory scope like the real one. */
  spawnClaudeCodeProcess?: (options: SpawnOptions) => ChildProcess
}

const text = (m: UserMessage) =>
  typeof m.message.content === 'string'
    ? m.message.content
    : m.message.content.map((block) => block.text ?? '').join('')

/** Lets one waiter sleep until a message arrives or the session ends. */
class Outbox {
  private readonly items: Message[] = []
  private wake: (() => void) | null = null
  private failure: Error | null = null
  ended = false

  push(m: Message): void {
    this.items.push(m)
    this.poke()
  }

  end(): void {
    this.ended = true
    this.poke()
  }

  /** Ends the stream with an error, as a Claude Code process that exits does. */
  fail(error: Error): void {
    this.failure = error
    this.end()
  }

  async *drain(): AsyncGenerator<Message> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
      } else if (this.ended) {
        if (this.failure !== null) {
          throw this.failure
        }
        return
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      }
    }
  }

  private poke(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

/**
 * The e2e suite's stand-in for Claude Code, which Seti loads through SETI_SDK_MODULE. A prompt
 * that asks for a background shell starts a real process tree under a placeholder Claude Code
 * process, so the Processes view has something real to list and stop.
 */
class FakeClaude {
  /** Like Claude Code, a resumed session keeps its id. */
  private readonly session: string
  private readonly outbox = new Outbox()
  private readonly options: Options
  private claude: ChildProcess | null = null
  private readonly shells = new Map<string, string>()
  private release: (() => void) | null = null
  /** Query.interrupt cut the held turn short, so it ends as Claude Code's interrupted turns do. */
  private cut = false
  private seti: InProcessClient | null = null

  constructor(options: Options) {
    this.options = options
    this.session = options.resume ?? randomUUID()
  }

  private sdk(m: Message): void {
    this.outbox.push({ session_id: this.session, uuid: randomUUID(), ...m })
  }

  private assistant(content: unknown[]): void {
    this.sdk({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude-fake', content },
    })
  }

  private result(): void {
    const cut = this.cut && !this.outbox.ended
    this.cut = false
    if (cut) {
      this.sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: INTERRUPT_MARKER } })
    }
    this.sdk({
      type: 'result',
      subtype: cut ? 'error_during_execution' : 'success',
      is_error: cut,
      result: 'done',
      errors: [],
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 1,
    })
  }

  private background(): void {
    const tasks = [...this.shells].map(([id]) => ({
      task_id: id,
      task_type: 'local_bash',
      description: SHELL_DESCRIPTION,
    }))
    this.sdk({ type: 'system', subtype: 'background_tasks_changed', tasks })
  }

  private outputFile(shellId: string): string {
    const slug = (this.options.cwd ?? 'cwd').replace(/[^\w]/g, '-')
    return path.join(
      os.tmpdir(),
      `claude-${String(os.userInfo().uid)}`,
      slug,
      this.session,
      'tasks',
      `${shellId}.output`,
    )
  }

  private startShell(): void {
    const shellId = `b${randomUUID().replace(/-/g, '').slice(0, 8)}`
    const toolUseId = `toolu_${shellId}`
    const file = this.outputFile(shellId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.assistant([
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'Bash',
        input: { command: SHELL_COMMAND, description: SHELL_DESCRIPTION, run_in_background: true },
      },
    ])
    const env = { ...process.env, ...this.options.env }
    const args = ['-c', 'bash -c "$0" > "$1" 2>&1 & exec sleep 3600', SHELL_COMMAND, file]
    this.claude?.kill('SIGKILL')
    const launch = this.options.spawnClaudeCodeProcess
    this.claude =
      launch === undefined
        ? spawn('/bin/bash', args, { env, stdio: 'ignore' })
        : launch({ command: '/bin/bash', args, env, signal: new AbortController().signal })
    this.shells.set(shellId, file)
    this.background()
    this.sdk({
      type: 'system',
      subtype: 'task_started',
      task_id: shellId,
      tool_use_id: toolUseId,
      description: SHELL_DESCRIPTION,
      is_backgrounded: true,
      task_type: 'local_bash',
    })
    this.sdk({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `Command running in background with ID: ${shellId}. Output is being written to: ${file}. You will be notified when it completes.`,
          },
        ],
      },
      tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: shellId },
    })
    this.assistant([{ type: 'text', text: 'The dev server runs in the background.' }])
  }

  /** Reports the session's start, as Claude Code does, and names the session it resumed. */
  private whichSession(): void {
    this.sdk({
      type: 'system',
      subtype: 'init',
      model: 'claude-fake',
      permissionMode: 'auto',
      cwd: this.options.cwd ?? '',
      tools: [],
      plugins: [],
      mcp_servers: [],
    })
    this.assistant([{ type: 'text', text: `Session ${this.session}, resumed ${this.options.resume ?? 'none'}` }])
  }

  private async hold(): Promise<void> {
    this.assistant([{ type: 'text', text: 'Working on it.' }])
    await new Promise<void>((resolve) => {
      this.release = resolve
    })
  }

  interrupt(): void {
    this.cut = this.release !== null
    this.release?.()
    this.release = null
  }

  private toolResult(toolUseId: string, content: string, output?: unknown): void {
    this.sdk({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
      ...(output === undefined ? {} : { tool_use_result: output }),
    })
  }

  /** Asks Seti to run a command no rule allows, then runs it or says why it did not. */
  private async askPermission(): Promise<void> {
    const id = `toolu_perm_${randomUUID().slice(0, 8)}`
    this.assistant([{ type: 'tool_use', id, name: 'Bash', input: PERMISSION_INPUT }])
    const { result, reply } = await askToDeploy(this.options.canUseTool, id)
    if (!this.outbox.ended) {
      this.toolResult(id, result)
      this.assistant([{ type: 'text', text: reply }])
    }
  }

  /** What a scripted turn uses to speak, return tool results and see the session end. */
  private actor(): StepActor {
    return {
      assistant: (content) => {
        this.assistant(content)
      },
      toolResult: (id, content, output) => {
        this.toolResult(id, content, output)
      },
      ended: () => this.outbox.ended,
    }
  }

  /** Calls a seti tool as Claude Code would, shows the call and its answer, then holds if asked. */
  private async callSeti(tool: string, args: string, hold: boolean): Promise<void> {
    const instance = this.options.mcpServers?.seti?.instance
    if (instance === undefined) {
      this.assistant([{ type: 'text', text: NO_SETI_TOOLS }])
      return
    }
    this.seti ??= new InProcessClient(instance)
    if (!(await this.seti.tools()).includes(tool)) {
      this.assistant([{ type: 'text', text: NO_SETI_TOOLS }])
      return
    }
    const id = `toolu_seti_${randomUUID().slice(0, 8)}`
    const input = JSON.parse(args) as unknown
    this.assistant([{ type: 'tool_use', id, name: `mcp__seti__${tool}`, input }])
    this.toolResult(id, await this.seti.call(tool, input))
    this.assistant([{ type: 'text', text: `Called seti ${tool}.` }])
    if (hold) {
      await this.hold()
    }
  }

  /** The shells' processes are the placeholder's children; ending them ends the shell. */
  private killShells(): void {
    const pid = this.claude?.pid
    if (pid === undefined) {
      return
    }
    let children = ''
    try {
      children = fs.readFileSync(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8')
    } catch {
      return
    }
    for (const child of children.split(' ').filter((word) => word !== '')) {
      try {
        process.kill(Number(child), 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }

  async run(input: AsyncIterable<UserMessage>): Promise<void> {
    for await (const m of input) {
      if (this.outbox.ended) {
        break
      }
      if (m.uuid !== undefined) {
        this.sdk({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'started' })
      }
      const reason = FAIL_REASON.exec(text(m))?.[1]
      if (reason !== undefined && !failedOnce.has(text(m))) {
        failedOnce.add(text(m))
        this.assistant([{ type: 'text', text: 'Starting.' }])
        this.outbox.fail(new Error(`Claude Code process exited with code 1: ${reason}`))
        return
      }
      await (text(m).includes(PERMISSION_PROMPT) ? this.askPermission() : this.answer(text(m)))
      this.result()
    }
    this.close()
  }

  /** Acts out the turn a prompt asks for, short of its result. */
  private async answer(prompt: string): Promise<void> {
    const seti = SETI_CALL.exec(prompt)
    const gate = gateOf(prompt)
    if (seti?.[1] !== undefined && seti[2] !== undefined) {
      await this.callSeti(seti[1], seti[2], prompt.includes(HOLD_PROMPT))
    } else if (prompt.includes(REPEAT_PROMPT)) {
      await repeatBuild(this.options.hooks, this.actor())
    } else if (prompt.includes(SHELL_PROMPT)) {
      this.startShell()
    } else if (prompt.includes(LIMIT_PROMPT)) {
      for (const shellId of [...this.shells.keys()]) {
        this.stopTask(shellId, LIMIT_SUMMARY)
      }
    } else if (gate !== undefined) {
      await actSteps(prompt, gate, this.actor(), ASK_REPLY)
    } else if (prompt.includes(HOLD_PROMPT)) {
      await this.hold()
    } else if (prompt.includes(SESSION_PROMPT)) {
      this.whichSession()
    } else if (prompt.includes(SYSTEM_PROMPT_PROMPT)) {
      this.assistant([{ type: 'text', text: this.options.systemPrompt?.append ?? '' }])
    } else {
      this.assistant([{ type: 'text', text: plainReply(prompt) }])
    }
  }

  stopTask(shellId: string, summary = SHELL_DESCRIPTION): void {
    const file = this.shells.get(shellId)
    if (file === undefined) {
      return
    }
    this.killShells()
    this.shells.delete(shellId)
    this.sdk({
      type: 'system',
      subtype: 'task_updated',
      task_id: shellId,
      patch: { status: 'killed', end_time: Date.now() },
    })
    this.sdk({
      type: 'system',
      subtype: 'task_notification',
      task_id: shellId,
      tool_use_id: `toolu_${shellId}`,
      status: 'stopped',
      output_file: file,
      summary,
    })
    this.background()
  }

  close(): void {
    this.interrupt()
    this.killShells()
    this.claude?.kill('SIGKILL')
    this.claude = null
    this.outbox.end()
  }

  messages(): AsyncGenerator<Message> {
    return this.outbox.drain()
  }
}

/** The Agent SDK's streaming `query`, as far as Seti's runner and side chats use it. */
export function query({ prompt, options = {} }: { prompt: AsyncIterable<UserMessage>; options?: Options }) {
  if (options.forkSession === true) {
    return sideChatQuery(prompt, options)
  }
  const fake = new FakeClaude(options)
  void fake.run(prompt)
  return Object.assign(fake.messages(), {
    interrupt: async () => {
      fake.interrupt()
      return Promise.resolve()
    },
    stopTask: async (taskId: string) => {
      fake.stopTask(taskId)
      return Promise.resolve()
    },
    close: () => {
      fake.close()
    },
  })
}
