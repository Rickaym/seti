import type { EventOf, RuntimeEvent } from '@seti/shared'
import type { Launcher } from '../launcher.js'
import type { SessionInput, SessionReport } from './adapter.js'

/** One model call with no tools: what it asks of which model, and its bounds. */
export interface OneShotRequest {
  model: string
  /** What the model is told about the call, as its system text. */
  system: string
  prompt: string
  /** An empty folder the session starts in, holding nothing of the agent's. */
  cwd: string
  /** The most tokens the model may write. */
  maxOutputTokens: number
  /** The most the call may spend, in US dollars at list price. */
  budgetUsd: number
}

/** A one-shot session: its reports until its one turn ends, and the control to end it. */
interface OneShotSession {
  readonly events: AsyncIterable<SessionReport>
  close(): void
}

type Usage = EventOf<'usage'>['usage']

/**
 * How a runtime answers one question with no tools: a new session that offers the model no tool
 * and refuses any call it makes, never asking, and resumes and keeps nothing.
 */
export interface OneShot {
  open: (request: OneShotRequest, launcher: Launcher, abortController: AbortController) => Promise<OneShotSession>
  /** The session's cost so far as a message of the runtime reports it, where it does. */
  reportedCost?: (raw: unknown) => number | null
  /** The estimated cost of one model call's tokens, where the runtime reports none. */
  price?: (model: string, usage: Usage) => number | null
}

/** What a one-shot answered and spent. */
export interface OneShotResult {
  text: string
  model: string
  tokens: { input: number; output: number }
  /** Null when the runtime reported no cost and the model has no price. */
  costUsd: number | null
  costEstimated: boolean
  durationMs: number
  /** Tool calls the model tried, each refused. */
  refused: number
}

/** The tool calls a one-shot refuses before Seti ends it, since each costs another model call. */
const MAX_REFUSED = 2

/** The one input of a one-shot, after which its session takes no more. */
export async function* oneInput(text: string): AsyncIterable<SessionInput> {
  yield await Promise.resolve({ id: 'one-shot', content: { text, images: [] } })
}

/** What a one-shot's reports added up to while it ran. */
class Tally {
  text = ''
  refused = 0
  reported: number | null = null
  priced: number | null = 0
  readonly tokens = { input: 0, output: 0 }
  ended: EventOf<'turn.ended'> | null = null

  private readonly oneShot: OneShot
  private readonly model: string

  constructor(oneShot: OneShot, model: string) {
    this.oneShot = oneShot
    this.model = model
  }

  take(report: SessionReport): void {
    if (report.type !== 'message') {
      return
    }
    this.reported = this.oneShot.reportedCost?.(report.raw) ?? this.reported
    for (const event of report.events) {
      if (event.thread === '') {
        this.event(event)
      }
    }
  }

  private event(event: RuntimeEvent): void {
    if (event.type === 'message' && event.role === 'agent') {
      this.text = event.text
    } else if (event.type === 'tool.started') {
      this.refused += 1
    } else if (event.type === 'usage') {
      this.tokens.input += event.usage.input + (event.usage.cacheRead ?? 0)
      this.tokens.output += event.usage.output
      const cost = this.oneShot.price?.(this.model, event.usage) ?? null
      this.priced = this.priced === null || cost === null ? null : this.priced + cost
    } else if (event.type === 'turn.ended') {
      this.ended = event
    }
  }

  /** Why the one-shot must end now, or null while it may go on. */
  overrun(request: OneShotRequest): string | null {
    if (this.refused > MAX_REFUSED) {
      return 'The model kept trying to use tools, which a one-shot call does not offer.'
    }
    return this.tokens.output > request.maxOutputTokens ? 'The model wrote more than the call allows.' : null
  }
}

/** The answer of a turn that ended, or the error it ended with. */
function answered(tally: Tally, request: OneShotRequest, startedAt: number): OneShotResult {
  const ended = tally.ended
  if (ended === null) {
    throw new Error('The model ended without an answer.')
  }
  if (ended.status !== 'ok') {
    throw new Error(ended.error ?? `The model's turn ended ${ended.status}.`)
  }
  const usage = ended.usage
  const tokens =
    tally.tokens.input + tally.tokens.output > 0 || usage === undefined
      ? tally.tokens
      : { input: usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0), output: usage.output }
  const reported = ended.costUsd ?? tally.reported
  return {
    text: ended.result.trim() === '' ? tally.text : ended.result,
    model: request.model,
    tokens,
    costUsd: reported ?? tally.priced,
    costEstimated: reported === null && tally.priced !== null,
    durationMs: Date.now() - startedAt,
    refused: tally.refused,
  }
}

/** Reads the session until its turn ends or it must stop; rejects with the reason it stopped. */
async function readTurn(session: OneShotSession, tally: Tally, request: OneShotRequest): Promise<void> {
  for await (const report of session.events) {
    tally.take(report)
    const overrun = tally.overrun(request)
    if (overrun !== null) {
      throw new Error(overrun)
    }
    if (tally.ended !== null) {
      return
    }
  }
}

/** A promise that rejects once the time is up or the signal aborts, whichever comes first. */
function deadline(timeoutMs: number, signal: AbortSignal): { promise: Promise<never>; clear: () => void } {
  let clear: () => void = () => undefined
  const promise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`No answer within ${String(Math.round(timeoutMs / 1000))} seconds.`))
    }, timeoutMs)
    const aborted = () => {
      reject(new Error('The call was stopped.'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    clear = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
    }
  })
  promise.catch(() => undefined)
  return { promise, clear }
}

/**
 * Runs one call on a runtime's one-shot and returns its answer; the session ends either way. It
 * rejects with a plain reason when the time is up, the signal aborts, the model keeps calling
 * tools or writes past its limit, or the turn fails.
 */
export async function runOneShot(
  oneShot: OneShot,
  request: OneShotRequest,
  launcher: Launcher,
  limits: { timeoutMs: number; signal: AbortSignal },
): Promise<OneShotResult> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const stop = deadline(limits.timeoutMs, limits.signal)
  const tally = new Tally(oneShot, request.model)
  let session: OneShotSession | null = null
  try {
    session = await Promise.race([oneShot.open(request, launcher, controller), stop.promise])
    await Promise.race([readTurn(session, tally, request), stop.promise])
    return answered(tally, request, startedAt)
  } finally {
    stop.clear()
    session?.close()
    controller.abort()
  }
}
