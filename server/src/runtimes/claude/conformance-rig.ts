import type { Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { aborted, fakeMessage, FakeSdk, type FakeSession } from '../../fake-sdk.js'
import type { Launcher } from '../../launcher.js'
import { FakeProcess, launcherOf } from '../conformance/process.js'
import { echoOf, type Script, type ScriptCall, type Step } from '../conformance/script.js'
import type { Rig, SpawnRecord } from '../conformance/target.js'
import { answered, claudeTool, isGated } from './conformance-tools.js'

/** When a call's tool answers: after its delay, or never for a held one. */
const answerOf = async (call: ScriptCall): Promise<void> =>
  new Promise((resolve) => {
    if (call.hold !== true) {
      setTimeout(resolve, call.delayMs ?? 0)
    }
  })

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

/** Steps that are neither talk, calls nor waits. */
type OtherStep =
  | { plan: unknown }
  | { compact: unknown }
  | { fallback: string }
  | { malformed: true }
  | { unknown: string }
  | { garbage: string }
  | { exit: number }

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
  readonly script: Script
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
  /** The subagent whose steps play now, by the call that started it; the agent's own when null. */
  private thread: string | null = null
  private readonly machine: Machine
  private readonly turn: FakeTurn
  private readonly session: Saved

  constructor(machine: Machine, turn: FakeTurn, session: Saved) {
    this.machine = machine
    this.turn = turn
    this.session = session
  }

  message(type: string, extra: Record<string, unknown>): Message {
    return fakeMessage(type, { session_id: this.session.id, parent_tool_use_id: this.thread, ...extra })
  }

  assistant(content: unknown[]): Message {
    return this.message('assistant', { message: { role: 'assistant', content } })
  }

  async *play(step: Step): AsyncGenerator<Message> {
    if ('say' in step || 'recall' in step) {
      const text = 'say' in step ? step.say : this.session.history.join('|')
      this.reply = this.thread === null ? text : this.reply
      yield this.assistant([{ type: 'text', text }])
    } else if ('think' in step) {
      yield this.assistant([{ type: 'thinking', thinking: step.think, signature: '' }])
    } else if ('call' in step) {
      yield* this.call(step.call)
    } else if ('job' in step) {
      yield* this.job(step.job)
    } else if ('subagent' in step) {
      yield* this.subagent(step.subagent)
    } else if ('hold' in step) {
      await aborted(this.turn.signal)
    } else if ('awaitInput' in step) {
      await Promise.race([this.turn.queued(), aborted(this.turn.signal)])
      this.session.history.push(...(this.turn.signal.aborted ? [] : this.turn.fold()))
    } else {
      yield* this.other(step)
    }
  }

  /** Plays a plan change, a compaction, or a step that misbehaves. */
  private async *other(step: Extract<Step, OtherStep>): AsyncGenerator<Message> {
    if ('plan' in step) {
      yield* this.call({ tool: 'todo', args: { items: step.plan } })
    } else if ('fallback' in step) {
      const models = { original_model: 'claude-fake', fallback_model: step.fallback }
      yield this.message('system', { subtype: 'model_refusal_fallback', ...models, request_id: null, content: 'moved' })
    } else if ('compact' in step) {
      yield this.message('system', { subtype: 'status', status: 'compacting' })
      const metadata = { trigger: step.compact.trigger, pre_tokens: step.compact.before }
      yield this.message('system', { subtype: 'compact_boundary', compact_metadata: metadata })
      yield this.message('system', { subtype: 'status', status: null })
    } else if ('malformed' in step) {
      yield this.message('assistant', { message: null })
    } else if ('unknown' in step) {
      yield this.message(step.unknown, {})
    } else if ('garbage' in step) {
      throw new Error("The SDK parses Claude Code's output, so a stray line never reaches the adapter")
    } else {
      throw new Error(`Claude Code process exited with code ${String(step.exit)}`)
    }
  }

  /** Plays a subagent through the Task tool; its messages name the call as their parent. */
  private async *subagent(agent: Extract<Step, { subagent: unknown }>['subagent']): AsyncGenerator<Message> {
    const background = agent.background === true
    const id = this.machine.nextId('toolu_')
    const input = { description: agent.label, prompt: agent.label, ...(background ? { run_in_background: true } : {}) }
    yield this.assistant([{ type: 'tool_use', id, name: 'Task', input }])
    const task = this.machine.nextId('agent_')
    const job = { task, call: id, label: agent.label }
    if (background) {
      yield this.result(id, `Async agent launched successfully. agentId: ${task}`, false)
      const started = { subtype: 'task_started', task_id: task, tool_use_id: id, description: agent.label }
      yield this.message('system', { ...started, task_type: 'local_agent' })
    }
    const outer = this.thread
    this.thread = id
    let report = ''
    for (const step of agent.steps) {
      report = 'say' in step ? step.say : report
      yield* this.play(step)
    }
    this.thread = outer
    yield background ? jobEnded(job, 'completed') : this.result(id, report, false)
  }

  /** Claude Code's report of a call's result, in the thread playing now. */
  private result(id: string, content: string, isError: boolean): Message {
    return this.message('user', {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    })
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
    const result = (content: string, isError: boolean) => this.result(id, content, isError)
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
    if (call.hold === true || call.delayMs !== undefined) {
      const cut = await Promise.race([answerOf(call).then(() => false), aborted(this.turn.signal).then(() => true)])
      if (cut) {
        this.machine.effects.push(`cancelled ${call.tool}`)
        yield result('[Request interrupted by user for tool use]', true)
        return null
      }
    }
    const output = name === 'AskUserQuestion' ? answered(decision.updatedInput) : (call.output ?? '')
    yield result(output, call.fails === true)
    return id
  }
}

/** Claude Code's side of a turn: its start report, the script's steps, and the result. */
const turnScript = (machine: Machine): TurnScript =>
  async function* (turn) {
    if (machine.script.exitAtStart !== undefined) {
      throw new Error(`Claude Code process exited with code ${String(machine.script.exitAtStart)}`)
    }
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
 * starts the process through `spawnClaudeCodeProcess` when Seti hands one, and else by itself.
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
  const selfStarts: SpawnRecord[] = []
  const start: NonNullable<Launcher['spawn']> = (request) => {
    spawns.push({ command: request.command, args: request.args, cwd: request.cwd, env: request.env })
    return new FakeProcess(request.signal, script.deaf === true)
  }
  slot.route((args) => {
    const options = args.options ?? {}
    const request = { command: 'claude', args: ['--output-format', 'stream-json'], env: options.env ?? {} }
    if (options.spawnClaudeCodeProcess === undefined) {
      selfStarts.push({ ...request, cwd: options.cwd })
    } else {
      options.spawnClaudeCodeProcess({
        ...request,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        signal: options.abortController?.signal ?? new AbortController().signal,
      })
    }
    return sdk.query(args)
  })
  return {
    launcher: launcherOf(script, start),
    spawns,
    selfStarts,
    effects: machine.effects,
    crash: (code) => {
      sdk.last?.fail(new Error(`Claude Code process exited with code ${String(code)}`))
    },
  }
}
