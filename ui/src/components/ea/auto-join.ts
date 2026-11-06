import { callActive, type CallState } from './call-state'

export type MicPermission = 'granted' | 'prompt' | 'denied'

/** What joining on open is doing; `held` means the user hung up in this tab. */
export type AutoJoinStatus = 'off' | 'joined' | 'needs-gesture' | 'blocked' | 'held'

interface CallPort {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => CallState
  connect: (options: { auto: boolean }) => Promise<void>
  hangUp: () => Promise<void>
}

export interface AutoJoinDeps {
  call: CallPort
  /** Waits until this tab leads the others, then calls `onLead`; returns a release. */
  lead: (onLead: () => void) => () => void
  micPermission: () => Promise<MicPermission>
  later: (task: () => void, ms: number) => () => void
  now: () => number
}

/** Waits before each retry after a failed or dropped call; the last one repeats. */
export const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const
/** A call that stayed up this long starts the retries over from the shortest wait. */
export const STEADY_MS = 60_000

/** Joins the EA call asleep while Seti is open: one tab per browser, rejoining after drops. */
export class AutoJoin {
  private readonly deps: AutoJoinDeps
  private readonly listeners = new Set<() => void>()
  private status: AutoJoinStatus = 'off'
  private wanted = false
  private leading = false
  private held = false
  private failures = 0
  private connectedAt: number | null = null
  private checking = false
  private cancelRetry: (() => void) | null = null
  private releaseLead: (() => void) | null = null
  private last: CallState

  constructor(deps: AutoJoinDeps) {
    this.deps = deps
    this.last = deps.call.getSnapshot()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): AutoJoinStatus => this.status

  /** Follows the call until the returned stop; stopping releases the tab's lead. */
  readonly start = (): (() => void) => {
    this.last = this.deps.call.getSnapshot()
    const unsubscribe = this.deps.call.subscribe(this.onCall)
    this.step()
    return () => {
      unsubscribe()
      this.stopRetry()
      this.releaseLead?.()
      this.releaseLead = null
      this.leading = false
    }
  }

  /** Whether the user wants the EA joined on open and it can be: set, configured and running. */
  readonly setWanted = (wanted: boolean): void => {
    if (wanted === this.wanted) {
      return
    }
    this.wanted = wanted
    this.held = false
    this.failures = 0
    if (this.status === 'blocked' || this.status === 'needs-gesture') {
      this.setStatus('off')
    }
    this.step()
  }

  /** The user pressed the prompt, which lets the browser open the microphone and play audio. */
  readonly activate = (): void => {
    if (this.status !== 'needs-gesture' || callActive(this.deps.call.getSnapshot().phase)) {
      return
    }
    this.stopRetry()
    this.setStatus('joined')
    void this.deps.call.connect({ auto: true })
  }

  private setStatus(status: AutoJoinStatus): void {
    if (status === this.status) {
      return
    }
    this.status = status
    for (const listener of this.listeners) {
      listener()
    }
  }

  private stopRetry(): void {
    this.cancelRetry?.()
    this.cancelRetry = null
  }

  private readonly onCall = (): void => {
    const next = this.deps.call.getSnapshot()
    const before = this.last
    this.last = next
    if (next.phase === before.phase) {
      return
    }
    if (next.phase === 'connected') {
      this.connectedAt = this.deps.now()
    }
    if (callActive(before.phase) && next.phase === 'idle') {
      this.held = this.wanted
    }
    if (next.phase === 'error' && this.wanted && this.leading) {
      this.retryLater()
    }
    this.step()
  }

  private retryLater(): void {
    const steady = this.connectedAt !== null && this.deps.now() - this.connectedAt >= STEADY_MS
    this.connectedAt = null
    this.failures = steady ? 0 : this.failures
    const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)] ?? STEADY_MS
    this.failures += 1
    this.stopRetry()
    this.cancelRetry = this.deps.later(() => {
      this.cancelRetry = null
      this.step()
    }, wait)
  }

  private step(): void {
    const call = this.deps.call.getSnapshot()
    if (!this.wanted) {
      this.stopRetry()
      this.releaseLead?.()
      this.releaseLead = null
      this.leading = false
      if (call.auto && callActive(call.phase)) {
        void this.deps.call.hangUp()
      }
      this.setStatus('off')
      return
    }
    if (!this.leading) {
      this.releaseLead ??= this.deps.lead(() => {
        this.leading = true
        this.step()
      })
      return
    }
    if (this.held) {
      this.setStatus('held')
      return
    }
    if (callActive(call.phase)) {
      this.setStatus('joined')
      return
    }
    if (this.cancelRetry !== null || this.checking || this.status === 'blocked' || this.status === 'needs-gesture') {
      return
    }
    void this.join()
  }

  private async join(): Promise<void> {
    this.checking = true
    const permission = await this.deps.micPermission().finally(() => {
      this.checking = false
    })
    if (!this.wanted || !this.leading || this.held || callActive(this.deps.call.getSnapshot().phase)) {
      this.step()
      return
    }
    if (permission !== 'granted') {
      this.setStatus(permission === 'denied' ? 'blocked' : 'needs-gesture')
      return
    }
    this.setStatus('joined')
    await this.deps.call.connect({ auto: true })
  }
}

/** The browser's microphone permission, as a prompt when the browser will not say. */
export async function browserMicPermission(): Promise<MicPermission> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' })
    return status.state
  } catch {
    return 'prompt'
  }
}

/** One tab of this browser at a time leads, through a Web Lock; without locks every tab does. */
export function lockLead(name: string): AutoJoinDeps['lead'] {
  return (onLead) => {
    if (!('locks' in navigator)) {
      onLead()
      return () => undefined
    }
    const aborted = new AbortController()
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    navigator.locks
      .request(name, { signal: aborted.signal }, async () => {
        onLead()
        await held
      })
      .catch(() => undefined)
    return () => {
      aborted.abort()
      release()
    }
  }
}
