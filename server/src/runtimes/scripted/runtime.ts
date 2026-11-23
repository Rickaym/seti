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

const MODEL = 'scripted-1'

/** Resolves with the verdict, or with null once the turn is interrupted. */
const verdictOrAbort = async (pending: Promise<Verdict>, signal: AbortSignal): Promise<Verdict | null> =>
  Promise.race([
    pending,
    new Promise<null>((resolve) => {
      signal.addEventListener('abort', () => {
        resolve(null)
      })
    }),
  ])

/**
 * The scripted runtime: plays a script one turn per batch of inputs, asks before every gated
 * call, and queues input that arrives during a turn for the next one.
 */
export class ScriptedRuntime {
  private session: { id: string; inputs: string[] } | null = null
  private readonly queue: Input[] = []
  private turn: AbortController | null = null
  private readonly pending = new Map<number, (verdict: Verdict) => void>()
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
      if (this.turn === null) {
        void this.runTurns()
      }
    } else if (command.t === 'interrupt') {
      this.turn?.abort()
      this.io.write({ t: 'ack', rid: command.rid, ok: true })
    } else {
      this.pending.get(command.rid)?.(command.verdict)
      this.pending.delete(command.rid)
    }
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
      await this.runTurn(this.session.inputs, this.queue.splice(0))
    }
  }

  private async runTurn(history: string[], batch: Input[]): Promise<void> {
    const turn = new AbortController()
    this.turn = turn
    const id = this.next('turn')
    const texts = batch.map((input) => input.text)
    const inputs = batch.map((input) => input.id)
    history.push(...texts)
    this.io.write({ t: 'begin', turn: id, inputs })
    const steps = this.machine.script.turns[this.machine.turns] ?? [{ say: echoOf(texts) }]
    this.machine.turns += 1
    let reply = ''
    for (const step of steps) {
      if (turn.signal.aborted || this.dead) {
        break
      }
      reply = (await this.play(step, history, turn.signal)) ?? reply
    }
    this.turn = null
    if (!this.dead) {
      const status = turn.signal.aborted ? 'interrupted' : 'ok'
      const tokens = { in: 10 * steps.length, out: 5 * steps.length }
      this.io.write({ t: 'end', turn: id, status, reply, inputs, tokens, usd: 0.001 * steps.length })
    }
  }

  /** Plays one step; returns the agent's text when the step says something. */
  private async play(step: Step, history: string[], signal: AbortSignal): Promise<string | null> {
    if ('say' in step || 'recall' in step) {
      const text = 'say' in step ? step.say : history.join('|')
      this.io.write({ t: 'say', id: this.next('msg'), text })
      return text
    }
    if ('think' in step) {
      this.io.write({ t: 'think', id: this.next('think'), text: step.think })
    } else if ('call' in step) {
      await this.call(step.call, signal)
    } else if ('malformed' in step) {
      this.io.write({ t: 'say', id: 7 })
    } else if ('unknown' in step) {
      this.io.write({ t: step.unknown })
    } else {
      this.dead = true
      this.io.fail('scripted runtime crashed', step.exit)
    }
    return null
  }

  private async call(call: ScriptCall, signal: AbortSignal): Promise<void> {
    const id = this.next('call')
    this.io.write({ t: 'call', call: { id, tool: call.tool, args: call.args } })
    const verdict = isGated(call.tool) ? await this.ask(id, call, signal) : { allow: true as const }
    if (verdict === null) {
      this.io.write({ t: 'done', id, status: 'cancelled', output: '' })
      return
    }
    if (!verdict.allow) {
      this.io.write({ t: 'done', id, status: 'denied', output: verdict.message })
      return
    }
    const args = verdict.args ?? call.args
    this.machine.effects.push(`${call.tool} ${JSON.stringify(args)}`)
    const status = call.fails === true ? 'error' : 'ok'
    this.io.write({ t: 'done', id, status, output: call.output ?? '', ...(call.tool === 'sh' ? { exit: 0 } : {}) })
  }

  private async ask(id: string, call: ScriptCall, signal: AbortSignal): Promise<Verdict | null> {
    const rid = this.ids + 1
    this.ids = rid
    const verdict = new Promise<Verdict>((resolve) => {
      this.pending.set(rid, resolve)
    })
    this.io.write({ t: 'request', rid, call: { id, tool: call.tool, args: call.args } })
    return verdictOrAbort(verdict, signal)
  }
}
