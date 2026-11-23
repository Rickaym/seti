import type { Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { aborted, fakeMessage, FakeSdk, type FakeSession } from '../../fake-sdk.js'
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

/** The script's questions as AskUserQuestion takes them. */
const claudeQuestions = (questions: unknown) =>
  (Array.isArray(questions) ? (questions as { text: string; options: string[] }[]) : []).map((q) => ({
    question: q.text,
    header: 'Question',
    options: q.options.map((label) => ({ label, description: '' })),
    multiSelect: false,
  }))

/** What Claude Code tells the model once the user answered its questions. */
const answered = (input: Args | undefined): string =>
  `User has answered your questions: ${Object.entries((input?.answers ?? {}) as Record<string, string>)
    .map(([question, answer]) => `"${question}"="${answer}"`)
    .join(', ')}`

/** The script's tools as Claude Code names them, with Claude Code's input for the same call. */
const TOOLS = new Map<string, (args: Args) => [string, Args]>([
  [
    'sh',
    (args) => [
      'Bash',
      { command: args.cmd, description: 'Run it', ...(args.background === true ? { run_in_background: true } : {}) },
    ],
  ],
  ['cat', (args) => ['Read', { file_path: args.path }]],
  ['patch', (args) => ['Edit', { file_path: args.path, old_string: 'a', new_string: 'b' }]],
  ['grep', (args) => ['Grep', { pattern: args.pattern }]],
  ['fetch', (args) => ['WebFetch', { url: args.url, prompt: 'Read it' }]],
  ['ask', (args) => ['AskUserQuestion', { questions: claudeQuestions(args.questions) }]],
])

const claudeTool = (call: ScriptCall): [string, Args] => {
  const mcp = /^([\w-]+)\.([\w-]+)$/.exec(call.tool)
  if (mcp !== null) {
    return [`mcp__${mcp[1] ?? ''}__${mcp[2] ?? ''}`, call.args]
  }
  return TOOLS.get(call.tool)?.(call.args) ?? [call.tool, call.args]
}

/** Tools Claude Code asks about in its default mode when no rule allows them. */
const isGated = (name: string) =>
  ['Bash', 'Edit', 'Write', 'WebFetch', 'AskUserQuestion'].includes(name) || name.startsWith('mcp__')

/** A conversation Claude Code saved: its id and every input it read. */
interface Saved {
  id: string
  history: string[]
}

/** A background command a process started: its task id, the call that started it, its label. */
interface Job {
  task: string
  call: string
  label: string
}

/** Claude Code's report that a background command ended. */
const jobEnded = (job: Job, status: 'completed' | 'stopped') =>
  fakeMessage('system', {
    subtype: 'task_notification',
    task_id: job.task,
    tool_use_id: job.call,
    status,
    summary: job.label,
    output_file: '',
  })

/** What outlives one Claude Code process on the rig: saved conversations and what tools did. */
class Machine {
  readonly effects: string[] = []
  private readonly jobs = new WeakMap<FakeSession, Job[]>()
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

  addJob(session: FakeSession, job: Job): void {
    this.jobs.set(session, [...(this.jobs.get(session) ?? []), job])
  }

  /** Removes and returns the process's background commands, or only the one with the task id. */
  takeJobs(session: FakeSession, task?: string): Job[] {
    const all = this.jobs.get(session) ?? []
    const taken = all.filter((job) => task === undefined || job.task === task)
    this.jobs.set(
      session,
      all.filter((job) => !taken.includes(job)),
    )
    return taken
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
    } else if ('job' in step) {
      yield* this.job(step.job)
    } else if ('hold' in step) {
      await aborted(this.turn.signal)
    } else if ('awaitInput' in step) {
      await Promise.race([this.turn.queued(), aborted(this.turn.signal)])
      this.session.history.push(...(this.turn.signal.aborted ? [] : this.turn.fold()))
    } else if ('malformed' in step) {
      yield this.message('assistant', { message: null })
    } else if ('unknown' in step) {
      yield this.message(step.unknown, {})
    } else {
      throw new Error(`Claude Code process exited with code ${String(step.exit)}`)
    }
  }

  private async *job(label: string): AsyncGenerator<Message> {
    const task = this.machine.nextId('bash_')
    const output = `Command running in background with ID: ${task}`
    const call = yield* this.call({ tool: 'sh', args: { cmd: label, background: true }, output })
    if (call !== null) {
      yield this.message('system', {
        subtype: 'task_started',
        task_id: task,
        tool_use_id: call,
        description: label,
        task_type: 'local_bash',
        is_backgrounded: true,
      })
      this.machine.addJob(this.turn.session, { task, call, label })
    }
  }

  /** Plays a call; returns its id when it ran to its end. */
  private async *call(call: ScriptCall): AsyncGenerator<Message, string | null> {
    const id = this.machine.nextId('toolu_')
    const [name, input] = claudeTool(call)
    yield this.assistant([{ type: 'tool_use', id, name, input }])
    const ask = this.turn.session.options.canUseTool
    const result = (content: string, isError: boolean) =>
      this.message('user', {
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
      })
    const { signal } = this.turn
    const asked =
      isGated(name) && ask !== undefined
        ? await Promise.race([
            ask(name, input, { signal, toolUseID: id, requestId: `request-${id}` }),
            aborted(signal).then(() => null),
          ])
        : null
    if (signal.aborted) {
      yield result('[Request interrupted by user for tool use]', true)
      return null
    }
    const decision: PermissionResult = asked ?? { behavior: 'allow' }
    if (decision.behavior === 'deny') {
      yield result(decision.message, true)
      return null
    }
    this.machine.effects.push(`${call.tool} ${JSON.stringify(decision.updatedInput ?? input)}`)
    if (call.hold === true) {
      await aborted(this.turn.signal)
      yield result('[Request interrupted by user for tool use]', true)
      return null
    }
    const output = name === 'AskUserQuestion' ? answered(decision.updatedInput) : (call.output ?? '')
    yield result(output, call.fails === true)
    return id
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
    for (const job of machine.takeJobs(turn.session)) {
      yield jobEnded(job, 'completed')
    }
    for (const step of steps) {
      if (turn.signal.aborted) {
        return
      }
      yield* player.play(step)
    }
    if (turn.signal.aborted) {
      return
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
  sdk.interruptMode = script.refuseInterrupt === true ? 'reject' : 'honour'
  sdk.onStopTask = (session, task) => {
    for (const job of machine.takeJobs(session, task)) {
      session.emit(jobEnded(job, 'stopped'))
    }
  }
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
