import type { EventOf, RuntimeEvent } from '@seti/shared'
import type { RuntimeSession, RuntimeShapes, SessionInput, SessionReport } from '../adapter.js'

/** How long anything a case waits on may take; every case settles in milliseconds when it passes. */
const CASE_BOUND_MS = 2000

/** The promise's value, or a rejection naming what did not settle within the bound. */
export async function within<T>(promise: Promise<T>, label: string, bound = CASE_BOUND_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${String(bound)} ms`))
    }, bound)
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

/** An async iterable fed by `push`, ended by `end`. */
export class Channel<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private wake: (() => void) | null = null
  private over = false

  push(item: T): void {
    this.items.push(item)
    this.poke()
  }

  end(): void {
    this.over = true
    this.poke()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
      } else if (this.over) {
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

/** One message the runtime sent and its events: as reported, projected again, and as stored. */
export interface Projection {
  live: RuntimeEvent[]
  again: RuntimeEvent[]
  stored: RuntimeEvent[]
}

/** An open session as a case drives it: inputs in, neutral events out. */
export interface RunView {
  readonly events: readonly RuntimeEvent[]
  /** Every report of the session, in order. */
  readonly reports: readonly SessionReport[]
  /** Set once the session's events ended: null when they ended cleanly, else what they threw. */
  readonly outcome: Error | null | undefined
  send: (text: string) => string
  /** The first event from now on, or already seen, that passes the test. */
  until: (test: (event: RuntimeEvent) => boolean, label: string) => Promise<RuntimeEvent>
  /** The first report from now on, or already seen, that passes the test. */
  untilReport: (test: (report: SessionReport) => boolean, label: string) => Promise<SessionReport>
  /** Waits until the session's events end, within the bound. */
  settled: () => Promise<Error | null>
  interrupt: () => Promise<void>
  /** Takes back a queued input; null when the session cannot take one back. */
  retract: (inputId: string) => Promise<boolean> | null
  /** Stops a background job; null when the session cannot stop one. */
  stopBackground: (jobId: string) => Promise<void> | null
  close: () => void
  /** Aborts the controller the session was realised with. */
  abort: () => void
  projections: () => Projection[]
}

/** Lets messages already sent between Seti and an in-process runtime arrive before going on. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
  }
}

/** The event is the end of a turn of the agent itself. */
export const isTurnEnd = (event: RuntimeEvent): event is EventOf<'turn.ended'> =>
  event.type === 'turn.ended' && event.thread === ''

let inputs = 0

/** Drives one session: pumps its messages through the projector and wakes the waiting case. */
export class Run<S extends RuntimeShapes> implements RunView {
  readonly events: RuntimeEvent[] = []
  outcome: Error | null | undefined = undefined
  readonly reports: SessionReport[] = []
  private readonly waiters = new Set<() => void>()
  private readonly session: RuntimeSession<S>
  private readonly project: (message: unknown) => RuntimeEvent[]
  private readonly input: Channel<SessionInput>
  private readonly controller: AbortController

  constructor(
    session: RuntimeSession<S>,
    project: (message: unknown) => RuntimeEvent[],
    input: Channel<SessionInput>,
    controller: AbortController,
  ) {
    this.session = session
    this.project = project
    this.input = input
    this.controller = controller
  }

  /** Starts reading the session's messages. */
  start(): this {
    void this.pump()
    return this
  }

  send(text: string): string {
    inputs += 1
    const id = `input-${String(inputs)}`
    this.input.push({ id, content: { text, images: [] } })
    return id
  }

  async until(test: (event: RuntimeEvent) => boolean, label: string): Promise<RuntimeEvent> {
    return within(
      this.wait(() => this.events.find(test)),
      label,
    )
  }

  async untilReport(test: (report: SessionReport) => boolean, label: string): Promise<SessionReport> {
    return within(
      this.wait(() => this.reports.find(test)),
      label,
    )
  }

  async settled(): Promise<Error | null> {
    return within(
      this.wait(() => this.outcome),
      'the event stream',
    )
  }

  async interrupt(): Promise<void> {
    return within(this.session.interrupt(), 'interrupt')
  }

  retract(inputId: string): Promise<boolean> | null {
    const { retract } = this.session
    return retract === undefined ? null : within(retract(inputId), 'retract')
  }

  stopBackground(jobId: string): Promise<void> | null {
    const { stopBackground } = this.session
    return stopBackground === undefined ? null : within(stopBackground(jobId), 'stopBackground')
  }

  close(): void {
    this.input.end()
    this.session.close()
  }

  abort(): void {
    this.controller.abort()
  }

  projections(): Projection[] {
    return this.reports.flatMap((report) =>
      report.type === 'message'
        ? [
            {
              live: [...report.events],
              again: this.project(report.raw),
              stored: this.project(JSON.parse(JSON.stringify(report.raw))),
            },
          ]
        : [],
    )
  }

  /** Resolves with the first value the probe finds, checked now and after every change. */
  private async wait<T>(probe: () => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const found = probe()
        if (found !== undefined) {
          this.waiters.delete(check)
          resolve(found)
        } else if (this.outcome !== undefined) {
          this.waiters.delete(check)
          reject(new Error(`the session ended first (${this.outcome?.message ?? 'cleanly'})`))
        }
      }
      this.waiters.add(check)
      check()
    })
  }

  private async pump(): Promise<void> {
    try {
      for await (const report of this.session.events) {
        this.reports.push(report)
        this.events.push(...(report.type === 'message' ? report.events : []))
        this.notify()
      }
      this.outcome = null
    } catch (e) {
      this.outcome = e instanceof Error ? e : new Error(String(e))
    }
    this.notify()
  }

  private notify(): void {
    for (const check of [...this.waiters]) {
      check()
    }
  }
}
