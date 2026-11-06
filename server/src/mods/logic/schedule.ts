import { everyMs, type ModEvent } from '@seti/shared'
import type { ModEventOrigin } from './events.js'

/** A schedule as the manifest declares it. */
export interface ModSchedule {
  id: string
  every: string
}

type Timer = ReturnType<typeof setTimeout>

export interface ScheduleDeps {
  fire: (modId: string, event: ModEvent, origin: ModEventOrigin) => Promise<unknown>
  now?: () => number
  random?: () => number
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
}

/** Runs may start up to this share of the interval late, so mods on the same interval spread out. */
const JITTER = 0.1

function unrefTimer(fn: () => void, ms: number): Timer {
  const timer = setTimeout(fn, ms)
  timer.unref()
  return timer
}

/**
 * Fires a mod's onSchedule events until the returned function is called. A run starts only after
 * the one before it ended, and `since` is when the one before it started.
 */
export function scheduleMod(modId: string, schedules: readonly ModSchedule[], deps: ScheduleDeps): () => void {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const setTimer = deps.setTimer ?? unrefTimer
  const clearTimer = deps.clearTimer ?? clearTimeout
  const timers = new Map<string, Timer>()
  let stopped = false

  const arm = (schedule: ModSchedule, intervalMs: number, since: string | null) => {
    const delay = Math.round(intervalMs * (1 + JITTER * random()))
    timers.set(
      schedule.id,
      setTimer(() => {
        const started = new Date(now()).toISOString()
        const event: ModEvent = { kind: 'schedule', scheduleId: schedule.id, since, now: started }
        void deps
          .fire(modId, event, { caller: 'schedule' })
          .catch(() => undefined)
          .finally(() => {
            if (!stopped) {
              arm(schedule, intervalMs, started)
            }
          })
      }, delay),
    )
  }

  for (const schedule of schedules) {
    const intervalMs = everyMs(schedule.every)
    if (intervalMs !== null) {
      arm(schedule, intervalMs, null)
    }
  }
  return () => {
    stopped = true
    for (const timer of timers.values()) {
      clearTimer(timer)
    }
    timers.clear()
  }
}
