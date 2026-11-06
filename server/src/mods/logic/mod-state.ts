import { MOD_LIMITS } from '@seti/shared'
import type { ModEventResult } from './child.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const BACKOFF_BASE_MS = MINUTE_MS

const dayOf = (at: number) => new Date(at).toDateString()

function nextMidnight(at: number): number {
  const date = new Date(at)
  date.setHours(24, 0, 0, 0)
  return date.getTime()
}

const minutes = (ms: number) => `${String(Math.max(1, Math.ceil(ms / MINUTE_MS)))} min`

/** What a finished event means for its mod: nothing, a pause until midnight, or turning it off. */
export interface Settled {
  paused: boolean
  turnOff: boolean
}

/** One mod's queue and counters: its event rate, failures, backoff and compute for the day. */
export class ModState<T> {
  readonly queue: T[] = []
  private busy = false
  private starts: number[] = []
  private failuresInRow = 0
  private failureTimes: number[] = []
  private backoffUntil = 0
  private pausedUntil = 0
  private day = ''
  private cpuToday: number | null = null

  get running(): boolean {
    return this.busy
  }

  /** Why the mod takes no event now, or null when it does. */
  refusal(name: string, at: number): string | null {
    if (this.pausedUntil > at) {
      return `${name} used its compute for today; it runs again at midnight`
    }
    if (this.backoffUntil > at) {
      const why = `failed ${String(this.failuresInRow)} times in a row`
      return `${name} ${why}; it runs again in ${minutes(this.backoffUntil - at)}`
    }
    this.starts = this.starts.filter((start) => start > at - MINUTE_MS)
    return this.starts.length >= MOD_LIMITS.eventsPerMinute ? `${name} is busy; try again` : null
  }

  started(at: number): void {
    this.busy = true
    this.starts.push(at)
  }

  finished(): void {
    this.busy = false
  }

  /** Loads the compute used today from the record once a day. */
  async today(at: number, load: () => Promise<number>): Promise<void> {
    if (this.day !== dayOf(at) || this.cpuToday === null) {
      this.day = dayOf(at)
      this.cpuToday = await load()
    }
  }

  /** Counts a finished event's compute and failure, and says what that means for the mod. */
  settle(result: ModEventResult, at: number): Settled {
    this.cpuToday = (this.cpuToday ?? 0) + result.usage.cpuMs
    const paused = this.cpuToday >= MOD_LIMITS.dailyCpuMs && this.pausedUntil <= at
    if (paused) {
      this.pausedUntil = nextMidnight(at)
    }
    if (result.ok || result.error.code === 'busy') {
      this.failuresInRow = result.ok ? 0 : this.failuresInRow
      return { paused, turnOff: false }
    }
    this.failuresInRow += 1
    this.failureTimes = [...this.failureTimes.filter((time) => time > at - HOUR_MS), at]
    if (this.failureTimes.length >= MOD_LIMITS.failuresPerHourTurnsOff) {
      this.failureTimes = []
      return { paused, turnOff: true }
    }
    if (this.failuresInRow >= MOD_LIMITS.failuresBeforeBackoff) {
      const doubled = BACKOFF_BASE_MS * 2 ** (this.failuresInRow - MOD_LIMITS.failuresBeforeBackoff)
      this.backoffUntil = at + Math.min(doubled, MOD_LIMITS.backoffMaxMs)
    }
    return { paused, turnOff: false }
  }
}
