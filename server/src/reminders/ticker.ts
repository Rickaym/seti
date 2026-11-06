import type { ReminderRun } from '@seti/shared'
import { createLimiter } from '../pollers/scheduler.js'

/** An enabled reminder with no next run, or one long past it. */
interface OverdueReminder {
  id: string
  next_run_at: string | null
}

export interface ReminderTickerDeps {
  /** Claims the reminders due at `at`, at most `limit`, and moves their next run forward. */
  claimDue: (at: string, limit: number) => Promise<{ id: string; due_at: string }[]>
  /** Enabled reminders with no next run, or whose next run is over an interval plus marginS past. */
  overdue: (at: string, marginS: number) => Promise<OverdueReminder[]>
  /** Makes these reminders due at `at`. */
  rearm: (ids: readonly string[], at: string) => Promise<void>
  /** The soonest next run of any enabled reminder, so a tick can be timed for it. */
  soonest: () => Promise<string | null>
  /** Runs one reminder; dueAt is when the schedule wanted it, null for a run on request. */
  run: (id: string, trigger: ReminderRun['trigger'], dueAt: string | null) => Promise<void>
  concurrency: number
  tickMs: number
  onError: (error: unknown) => void
  /** What the watchdog found wrong and mended. */
  onStale: (reason: string) => void
  now?: () => number
}

/** How many due reminders one tick takes; the rest wait for the next tick. */
const CLAIM_LIMIT = 20
const WATCH_MS = 60_000
/** How far past one interval a reminder's next run may slip before the watchdog re-arms it. */
const WATCH_MARGIN_S = 60
/** A tick going longer than this is taken as hung, and the next tick goes ahead without it. */
const TICK_STUCK_MS = 5 * 60_000

/**
 * One timer for every reminder: each tick claims the due ones in the database and runs them.
 * Ticks come every tickMs, and one more is timed for the soonest reminder due before then.
 */
export function createReminderTicker(deps: ReminderTickerDeps) {
  const now = deps.now ?? Date.now
  const limit = createLimiter(deps.concurrency)
  const running = new Set<string>()
  let timers: ReturnType<typeof setInterval>[] = []
  let wake: ReturnType<typeof setTimeout> | null = null
  let ticking: { done: Promise<void>; since: number } | null = null
  let idleWaiters: (() => void)[] = []

  async function runOne(id: string, trigger: ReminderRun['trigger'], dueAt: string | null): Promise<void> {
    running.add(id)
    try {
      await limit(async () => deps.run(id, trigger, dueAt))
    } finally {
      running.delete(id)
      if (running.size === 0) {
        const waiters = idleWaiters
        idleWaiters = []
        for (const resolve of waiters) {
          resolve()
        }
      }
    }
  }

  /** Times one extra tick for the soonest reminder due before the next regular tick. */
  async function timeNextTick(): Promise<void> {
    if (timers.length === 0) {
      return
    }
    const soonest = await deps.soonest()
    if (soonest === null) {
      return
    }
    const ahead = Date.parse(soonest) - now()
    // A reminder still due after a tick waits a second, so a locked claim cannot spin the loop.
    const delay = ahead > 0 ? ahead : 1000
    if (delay >= deps.tickMs) {
      return
    }
    if (wake !== null) {
      clearTimeout(wake)
    }
    wake = setTimeout(() => {
      wake = null
      void tick().catch(deps.onError)
    }, delay)
    wake.unref()
  }

  async function claimAndRun(): Promise<void> {
    const due = await deps.claimDue(new Date(now()).toISOString(), CLAIM_LIMIT)
    await Promise.all(
      due.map(async ({ id, due_at: dueAt }) => {
        if (!running.has(id)) {
          await runOne(id, 'schedule', dueAt).catch(deps.onError)
        }
      }),
    )
  }

  /** Runs the due reminders once; a tick still going makes this one wait for it, unless it hung. */
  async function tick(): Promise<void> {
    if (ticking !== null && now() - ticking.since > TICK_STUCK_MS) {
      deps.onStale(`a tick ran over ${String(TICK_STUCK_MS / 60_000)} min; the next one goes ahead`)
      ticking = null
    }
    if (ticking === null) {
      const current = {
        since: now(),
        done: claimAndRun().finally(() => {
          if (ticking === current) {
            ticking = null
          }
          void timeNextTick().catch(deps.onError)
        }),
      }
      ticking = current
    }
    await ticking.done
  }

  /** Re-arms reminders that lost their next run or fell far behind it, then ticks. */
  async function watch(): Promise<void> {
    const at = new Date(now()).toISOString()
    const stale = await deps.overdue(at, WATCH_MARGIN_S)
    if (stale.length === 0) {
      return
    }
    for (const reminder of stale) {
      const why = reminder.next_run_at === null ? 'had no next run' : `was due at ${reminder.next_run_at}`
      deps.onStale(`re-armed reminder ${reminder.id}, which ${why}`)
    }
    await deps.rearm(
      stale.map((reminder) => reminder.id),
      at,
    )
    await tick()
  }

  return {
    tick,
    watch,
    /** Runs one reminder now, outside its schedule; its next scheduled run keeps its time. */
    runNow: async (id: string): Promise<boolean> => {
      if (running.has(id)) {
        return false
      }
      await runOne(id, 'manual', null)
      return true
    },
    /** Takes a slot for a run outside the schedule, such as a test run. */
    withSlot: async <T>(job: () => Promise<T>): Promise<T> => limit(job),
    /** Resolves once no reminder runs, as Seti shuts down. */
    idle: async (): Promise<void> => {
      if (running.size > 0) {
        await new Promise<void>((resolve) => idleWaiters.push(resolve))
      }
    },
    start: () => {
      if (timers.length > 0) {
        return
      }
      const every = (fn: () => Promise<void>, ms: number) => {
        const timer = setInterval(() => {
          void fn().catch(deps.onError)
        }, ms)
        timer.unref()
        return timer
      }
      timers = [every(tick, deps.tickMs), every(watch, WATCH_MS)]
      void tick().catch(deps.onError)
    },
    stop: () => {
      for (const timer of timers) {
        clearInterval(timer)
      }
      timers = []
      if (wake !== null) {
        clearTimeout(wake)
        wake = null
      }
    },
  }
}
