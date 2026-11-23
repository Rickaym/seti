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
      this.io.write({ t: 'say', id: this.next('msg'), text })
      return text
    }
    if ('think' in step) {
      this.io.write({ t: 'think', id: this.next('think'), text: step.think })
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

  private misbehave(step: Extract<Step, { malformed: true } | { unknown: string } | { exit: number }>): void {
    if ('malformed' in step) {
      this.io.write({ t: 'say', id: 7 })
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
    this.io.write({ t: 'call', call: { id, tool: call.tool, args: call.args } })
    const verdict = isGated(call.tool) ? await this.ask(id, call, signal) : { allow: true as const }
    if (verdict === null) {
      this.io.write({ t: 'done', id, status: 'cancelled', output: '' })
      return null
    }
    if (!verdict.allow) {
      this.io.write({ t: 'done', id, status: 'denied', output: verdict.message })
      return null
    }
    this.machine.effects.push(`${call.tool} ${JSON.stringify(verdict.args ?? call.args)}`)
    if (call.hold === true) {
      await orAbort(forever, signal)
      this.io.write({ t: 'done', id, status: 'cancelled', output: '' })
      return null
    }
    const status = call.fails === true ? 'error' : 'ok'
    const exit = call.tool === 'sh' ? { exit: call.fails === true ? 1 : 0 } : {}
    this.io.write({ t: 'done', id, status, output: call.output ?? '', ...exit })
    return id
  }

  private async ask(id: string, call: ScriptCall, signal: AbortSignal): Promise<Verdict | null> {
    const rid = this.ids + 1
    this.ids = rid
    const verdict = new Promise<Verdict>((resolve) => {
      this.pending.set(rid, resolve)
    })
    this.io.write({ t: 'request', rid, call: { id, tool: call.tool, args: call.args } })
    return orAbort(verdict, signal)
  }
}
