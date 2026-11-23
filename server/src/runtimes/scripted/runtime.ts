import { echoOf, type Script, type ScriptCall, type Step } from '../conformance/script.js'
import type { ScriptedCommand, Verdict } from './dialect.js'
import { isGated } from './tools.js'

/** What outlives one process of the scripted runtime: saved sessions, and what tools did. */
export interface MachineState {
  readonly script: Script
  /** Each saved session's inputs, by session id, as the runtime's own files would hold them. */
  readonly sessions: Map<string, string[]>
  /** Every tool call that ran, as `<tool> <args as JSON>`, in order. */
  readonly effects: string[]
  /** Turns played on this machine, which picks the script's next turn. */
  turns: number
}

/** How the runtime reaches its process: its output lines, its error text, and its exit. */
export interface RuntimeIo {
  write: (line: unknown) => void
  fail: (text: string, code: number) => void
}

interface Input {
  id: string
  text: string
}

/** The turn being played: its inputs so far and what interrupts it. */
interface Turn {
  readonly id: string
  readonly inputs: string[]
  readonly abort: AbortController
}

const MODEL = 'scripted-1'

/** Resolves with the value, or with null once the signal aborts. */
const orAbort = async <T>(pending: Promise<T>, signal: AbortSignal): Promise<T | null> =>
  Promise.race([
    pending,
    new Promise<null>((resolve) => {
      if (signal.aborted) {
        resolve(null)
      }
      signal.addEventListener('abort', () => {
        resolve(null)
      })
    }),
  ])

/** Never settles: what a held step waits on until its turn is interrupted. */
const forever = new Promise<never>(() => undefined)

/**
 * The scripted runtime: plays a script one turn per batch of inputs, asks before every gated
 * call, takes input sent during a turn at its next `awaitInput` step or else in the next turn,
 * and keeps background commands running across turns and interrupts.
 */
export class ScriptedRuntime {
  private session: { id: string; inputs: string[] } | null = null
  private readonly queue: Input[] = []
  private turn: Turn | null = null
  private readonly pending = new Map<number, (verdict: Verdict) => void>()
  private readonly jobs = new Map<string, { call: string; label: string }>()
  private inputArrived: (() => void) | null = null
  /** The subagent thread whose steps play now; the agent's own when null. */
  private thread: string | null = null
  private ids = 0
  private dead = false
  private readonly machine: MachineState
  private readonly io: RuntimeIo

  constructor(machine: MachineState, io: RuntimeIo) {
    this.machine = machine
    this.io = io
  }

  receive(command: ScriptedCommand): void {
    if (command.t === 'open') {
      this.open(command.resume)
    } else if (command.t === 'input') {
      this.queue.push({ id: command.id, text: command.text })
      this.inputArrived?.()
      if (this.turn === null) {
        void this.runTurns()
      }
    } else if (command.t === 'interrupt') {
      this.interrupt(command.rid)
    } else if (command.t === 'retract') {
      const at = this.queue.findIndex((input) => input.id === command.id)
      this.queue.splice(at < 0 ? this.queue.length : at, 1)
      this.io.write({ t: 'ack', rid: command.rid, ok: true, taken: at >= 0 })
    } else if (command.t === 'stop') {
      this.endJob(command.job, 'stopped')
      this.io.write({ t: 'ack', rid: command.rid, ok: true })
    } else {
      this.pending.get(command.rid)?.(command.verdict)
      this.pending.delete(command.rid)
    }
  }

  private interrupt(rid: number): void {
    if (this.machine.script.refuseInterrupt === true) {
      this.io.write({ t: 'ack', rid, ok: false, error: 'interrupt is not available' })
      return
    }
    this.turn?.abort.abort()
    this.io.write({ t: 'ack', rid, ok: true })
  }

  private open(resume: string | null): void {
    const saved = resume === null ? [] : this.machine.sessions.get(resume)
    if (saved === undefined) {
      this.dead = true
      this.io.fail(`no saved session ${resume ?? ''}`, 1)
      return
    }
    const id = resume ?? `scripted-${String(this.machine.sessions.size + 1)}`
    this.machine.sessions.set(id, saved)
    this.session = { id, inputs: saved }
    this.io.write({ t: 'hello', session: id, model: MODEL, resumed: resume !== null })
  }

  private next(prefix: string): string {
    this.ids += 1
    return `${prefix}-${String(this.ids)}`
  }

  private async runTurns(): Promise<void> {
    while (this.queue.length > 0 && !this.dead && this.session !== null) {
      await this.runTurn(this.session.inputs)
    }
  }

  /** Moves the waiting inputs into the turn and the session's history; returns their texts. */
  private take(turn: Turn, history: string[]): string[] {
    const batch = this.queue.splice(0)
    turn.inputs.push(...batch.map((input) => input.id))
    history.push(...batch.map((input) => input.text))
    return batch.map((input) => input.text)
  }

  private async runTurn(history: string[]): Promise<void> {
    const turn: Turn = { id: this.next('turn'), inputs: [], abort: new AbortController() }
    this.turn = turn
    const texts = this.take(turn, history)
    this.io.write({ t: 'begin', turn: turn.id, inputs: [...turn.inputs] })
    for (const job of [...this.jobs.keys()]) {
      this.endJob(job, 'completed')
    }
    const steps = this.machine.script.turns[this.machine.turns] ?? [{ say: echoOf(texts) }]
    this.machine.turns += 1
    let reply = ''
    for (const step of steps) {
      if (turn.abort.signal.aborted || this.dead) {
        break
      }
      reply = (await this.play(step, history, turn)) ?? reply
    }
    this.turn = null
    if (!this.dead) {
      const status = turn.abort.signal.aborted ? 'interrupted' : 'ok'
      const tokens = { in: 10 * steps.length, out: 5 * steps.length }
      const { inputs } = turn
      this.io.write({ t: 'end', turn: turn.id, status, reply, inputs, tokens, usd: 0.001 * steps.length })
    }
  }

  /** Plays one step; returns the agent's text when the step says something. */
  private async play(step: Step, history: string[], turn: Turn): Promise<string | null> {
    if ('say' in step || 'recall' in step) {
      const text = 'say' in step ? step.say : history.join('|')
      this.io.write({ t: 'say', id: this.next('msg'), text, ...this.inThread() })
      return this.thread === null ? text : null
    }
    if ('think' in step) {
      this.io.write({ t: 'think', id: this.next('think'), text: step.think, ...this.inThread() })
    } else if ('subagent' in step) {
      await this.subagent(step.subagent, history, turn)
    } else if ('plan' in step || 'compact' in step || 'fallback' in step) {
      this.narrate(step)
    } else if ('call' in step) {
      await this.call(step.call, turn.abort.signal)
    } else if ('job' in step) {
      await this.startJob(step.job, turn.abort.signal)
    } else if ('hold' in step) {
      await orAbort(forever, turn.abort.signal)
    } else if ('awaitInput' in step) {
      await this.awaitInput(turn, history)
    } else {
      this.misbehave(step)
    }
    return null
  }

  /** The thread field of a line the runtime writes now. */
  private inThread(): { thread?: string } {
    return this.thread === null ? {} : { thread: this.thread }
  }

  /** Reports a plan change, a move to another model, or a compaction from its start to its end. */
  private narrate(step: Extract<Step, { plan: unknown } | { compact: unknown } | { fallback: string }>): void {
    if ('plan' in step) {
      this.io.write({ t: 'plan', items: step.plan })
      return
    }
    if ('fallback' in step) {
      this.io.write({ t: 'model', from: MODEL, to: step.fallback })
      return
    }
    const { trigger, before } = step.compact
    this.io.write({ t: 'compact', phase: 'started', trigger })
    this.io.write({ t: 'compact', phase: 'done', trigger, before })
  }

  /** Runs a subagent's steps in its thread; in the background its call ends first, then its job. */
  private async subagent(
    agent: Extract<Step, { subagent: unknown }>['subagent'],
    history: string[],
    turn: Turn,
  ): Promise<void> {
    const id = this.next('call')
    const background = agent.background === true
    const args = { label: agent.label, ...(background ? { background } : {}) }
    this.io.write({ t: 'call', call: { id, tool: 'agent', args }, ...this.inThread() })
    const job = { job: this.next('job'), call: id, label: agent.label, kind: 'subagent' as const }
    if (background) {
      this.io.write({ t: 'done', id, status: 'ok', output: `started ${agent.label}` })
      this.io.write({ t: 'job', ...job, phase: 'start' })
    }
    const outer = this.thread
    this.thread = id
    let report = ''
    for (const step of agent.steps) {
      report = 'say' in step ? step.say : report
      await this.play(step, history, turn)
    }
    this.thread = outer
    if (background) {
      this.io.write({ t: 'job', ...job, phase: 'end', status: 'completed' })
    } else {
      this.io.write({ t: 'done', id, status: 'ok', output: report, ...this.inThread() })
    }
  }

  private misbehave(
    step: Extract<Step, { malformed: true } | { unknown: string } | { garbage: string } | { exit: number }>,
  ): void {
    if ('malformed' in step) {
      this.io.write({ t: 'say', id: 7 })
    } else if ('garbage' in step) {
      this.io.write(step.garbage)
    } else if ('unknown' in step) {
      this.io.write({ t: step.unknown })
    } else {
      this.dead = true
      this.io.fail('scripted runtime crashed', step.exit)
    }
  }

  private async awaitInput(turn: Turn, history: string[]): Promise<void> {
    if (this.queue.length === 0) {
      await orAbort(
        new Promise<void>((resolve) => {
          this.inputArrived = resolve
        }),
        turn.abort.signal,
      )
      this.inputArrived = null
    }
    if (!turn.abort.signal.aborted) {
      this.take(turn, history)
    }
  }

  private async startJob(label: string, signal: AbortSignal): Promise<void> {
    const call = await this.call({ tool: 'sh', args: { cmd: label, background: true } }, signal)
    if (call !== null) {
      const job = this.next('job')
      this.jobs.set(job, { call, label })
      this.io.write({ t: 'job', job, call, label, phase: 'start' })
    }
  }

  private endJob(job: string, status: 'completed' | 'stopped'): void {
    const running = this.jobs.get(job)
    if (running !== undefined) {
      this.jobs.delete(job)
      this.io.write({ t: 'job', job, call: running.call, label: running.label, phase: 'end', status })
    }
  }

  /** Runs a call; returns its id when it ran to its end. */
  private async call(call: ScriptCall, signal: AbortSignal): Promise<string | null> {
    const id = this.next('call')
    const thread = this.inThread()
    this.io.write({ t: 'call', call: { id, tool: call.tool, args: call.args }, ...thread })
    const verdict = isGated(call.tool) ? await this.ask(id, call, signal) : { allow: true as const }
    if (verdict === null) {
      this.io.write({ t: 'done', id, status: 'cancelled', output: '', ...thread })
      return null
    }
    if (!verdict.allow) {
      this.io.write({ t: 'done', id, status: 'denied', output: verdict.message, ...thread })
      return null
    }
    this.machine.effects.push(`${call.tool} ${JSON.stringify(verdict.args ?? call.args)}`)
    if (call.hold === true) {
      await orAbort(forever, signal)
      this.io.write({ t: 'done', id, status: 'cancelled', output: '', ...thread })
      return null
    }
    const status = call.fails === true ? 'error' : 'ok'
    const exit = call.tool === 'sh' ? { exit: call.fails === true ? 1 : 0 } : {}
    const output = call.tool === 'ask' ? JSON.stringify(verdict.args?.answers ?? {}) : (call.output ?? '')
    this.io.write({ t: 'done', id, status, output, ...exit, ...thread })
    return id
  }

  private async ask(id: string, call: ScriptCall, signal: AbortSignal): Promise<Verdict | null> {
    const rid = this.ids + 1
    this.ids = rid
    const verdict = new Promise<Verdict>((resolve) => {
      this.pending.set(rid, resolve)
    })
    this.io.write({ t: 'request', rid, call: { id, tool: call.tool, args: call.args } })
    const answered = await orAbort(verdict, signal)
    if (answered === null) {
      this.pending.delete(rid)
      this.io.write({ t: 'withdraw', rid })
    }
    return answered
  }
}
