import type { Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { fakeMessage, FakeSdk, type FakeSession } from '../../fake-sdk.js'
import type { Launcher } from '../../launcher.js'
import { FakeProcess } from '../conformance/process.js'
import { echoOf, type Script, type ScriptCall, type Step } from '../conformance/script.js'
import type { Rig, SpawnRecord } from '../conformance/target.js'

/** What the SDK's query takes, as the rig answers it. */
interface QueryArgs {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}

/** The SDK's query as the suite's mock of the SDK module routes it: to the rig made last. */
export class QuerySlot {
  private current: ((args: QueryArgs) => unknown) | null = null

  query(args: QueryArgs): unknown {
    if (this.current === null) {
      throw new Error('No rig was made for this query')
    }
    return this.current(args)
  }

  route(query: (args: QueryArgs) => unknown): void {
    this.current = query
  }
}

type TurnScript = ConstructorParameters<typeof FakeSdk>[0]
type FakeTurn = Parameters<TurnScript>[0]
type Message = ReturnType<typeof fakeMessage>
type Args = Record<string, unknown>

/** The script's tools as Claude Code names them, with Claude Code's input for the same call. */
const TOOLS = new Map<string, (args: Args) => [string, Args]>([
  ['sh', (args) => ['Bash', { command: args.cmd, description: 'Run it' }]],
  ['cat', (args) => ['Read', { file_path: args.path }]],
  ['patch', (args) => ['Edit', { file_path: args.path, old_string: 'a', new_string: 'b' }]],
  ['grep', (args) => ['Grep', { pattern: args.pattern }]],
  ['fetch', (args) => ['WebFetch', { url: args.url, prompt: 'Read it' }]],
])

const claudeTool = (call: ScriptCall): [string, Args] => {
  const mcp = /^([\w-]+)\.([\w-]+)$/.exec(call.tool)
  if (mcp !== null) {
    return [`mcp__${mcp[1] ?? ''}__${mcp[2] ?? ''}`, call.args]
  }
  return TOOLS.get(call.tool)?.(call.args) ?? [call.tool, call.args]
}

/** Tools Claude Code asks about in its default mode when no rule allows them. */
const isGated = (name: string) => ['Bash', 'Edit', 'Write', 'WebFetch'].includes(name) || name.startsWith('mcp__')

/** A conversation Claude Code saved: its id and every input it read. */
interface Saved {
  id: string
  history: string[]
}

/** What outlives one Claude Code process on the rig: saved conversations and what tools did. */
class Machine {
  readonly effects: string[] = []
  private readonly saved = new Map<string, string[]>()
  private readonly sessions = new WeakMap<FakeSession, Saved>()
  private readonly script: Script
  private turns = 0
  private ids = 0

  constructor(script: Script) {
    this.script = script
  }

  nextId(prefix: string): string {
    this.ids += 1
    return `${prefix}${String(this.ids)}`
  }

  /** The next turn's steps; a turn past the script's end says its input back. */
  stepsFor(text: string): Step[] {
    const steps = this.script.turns[this.turns] ?? [{ say: echoOf([text]) }]
    this.turns += 1
    return steps
  }

  /** The conversation a process holds; resuming one the machine lacks fails as Claude Code does. */
  sessionOf(session: FakeSession): Saved {
    const known = this.sessions.get(session)
    if (known !== undefined) {
      return known
    }
    const resume = session.options.resume
    const history = resume === undefined ? [] : this.saved.get(resume)
    if (history === undefined) {
      throw new Error(`No conversation found with session ID: ${resume ?? ''}`)
    }
    const opened = { id: resume ?? this.nextId('claude-session-'), history }
    this.saved.set(opened.id, history)
    this.sessions.set(session, opened)
    return opened
  }
}

/** Plays one script step as the messages Claude Code writes for it. */
class TurnPlayer {
  reply = ''
  private readonly machine: Machine
  private readonly turn: FakeTurn
  private readonly session: Saved

  constructor(machine: Machine, turn: FakeTurn, session: Saved) {
    this.machine = machine
    this.turn = turn
    this.session = session
  }

  message(type: string, extra: Record<string, unknown>): Message {
    return fakeMessage(type, { session_id: this.session.id, parent_tool_use_id: null, ...extra })
  }

  assistant(content: unknown[]): Message {
    return this.message('assistant', { message: { role: 'assistant', content } })
  }

  async *play(step: Step): AsyncGenerator<Message> {
    if ('say' in step || 'recall' in step) {
      this.reply = 'say' in step ? step.say : this.session.history.join('|')
      yield this.assistant([{ type: 'text', text: this.reply }])
    } else if ('think' in step) {
      yield this.assistant([{ type: 'thinking', thinking: step.think, signature: '' }])
    } else if ('call' in step) {
      yield* this.call(step.call)
    } else if ('malformed' in step) {
      yield this.message('assistant', { message: null })
    } else if ('unknown' in step) {
      yield this.message(step.unknown, {})
    } else {
      throw new Error(`Claude Code process exited with code ${String(step.exit)}`)
    }
  }

  private async *call(call: ScriptCall): AsyncGenerator<Message> {
    const id = this.machine.nextId('toolu_')
    const [name, input] = claudeTool(call)
    yield this.assistant([{ type: 'tool_use', id, name, input }])
    const ask = this.turn.session.options.canUseTool
    const asked =
      isGated(name) && ask !== undefined
        ? await ask(name, input, { signal: this.turn.signal, toolUseID: id, requestId: `request-${id}` })
        : null
    const decision: PermissionResult = asked ?? { behavior: 'allow' }
    const result = (content: string, isError: boolean) =>
      this.message('user', {
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
      })
    if (decision.behavior === 'deny') {
      yield result(decision.message, true)
      return
    }
    this.machine.effects.push(`${call.tool} ${JSON.stringify(decision.updatedInput ?? input)}`)
    yield result(call.output ?? '', call.fails === true)
  }
}

/** Claude Code's side of a turn: its start report, the script's steps, and the result. */
const turnScript = (machine: Machine): TurnScript =>
  async function* (turn) {
    const session = machine.sessionOf(turn.session)
    session.history.push(turn.text)
    const steps = machine.stepsFor(turn.text)
    const player = new TurnPlayer(machine, turn, session)
    yield player.message('system', {
      subtype: 'init',
      model: 'claude-fake',
      permissionMode: 'default',
      cwd: turn.session.options.cwd ?? '',
      tools: [],
      mcp_servers: [],
      plugins: [],
    })
    for (const step of steps) {
      yield* player.play(step)
    }
    yield player.message('result', {
      subtype: 'success',
      is_error: false,
      result: player.reply,
      num_turns: steps.length,
      duration_ms: 1,
      total_cost_usd: 0.001 * steps.length,
      usage: { input_tokens: 10 * steps.length, output_tokens: 5 * steps.length },
    })
  }

/**
 * A host where Claude Code plays the script through `FakeSdk`. Like the real SDK, the query
 * starts the process through `spawnClaudeCodeProcess` when Seti hands one.
 */
export function claudeRig(slot: QuerySlot, script: Script): Rig {
  const machine = new Machine(script)
  const sdk = new FakeSdk(turnScript(machine))
  const spawns: SpawnRecord[] = []
  const spawn: NonNullable<Launcher['spawn']> = (request) => {
    spawns.push({ command: request.command, args: request.args, cwd: request.cwd, env: request.env })
    return new FakeProcess(request.signal)
  }
  slot.route((args) => {
    const options = args.options ?? {}
    options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: ['--output-format', 'stream-json'],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env ?? {},
      signal: options.abortController?.signal ?? new AbortController().signal,
    })
    return sdk.query(args)
  })
  return { launcher: { sandboxed: true, env: {}, spawn }, spawns, effects: machine.effects }
}
