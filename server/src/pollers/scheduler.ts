import type { PollerRunTrigger } from '@seti/shared'

/** What the scheduler needs to know of a poller. */
export interface SchedulablePoller {
  id: string
  interval_s: number
  enabled: boolean
  failures: number
  next_run_at: string | null
}

type Timer = ReturnType<typeof setTimeout>

/** How a run ended for the scheduler: its failures in a row, or null when Seti stopped it. */
type RunEnd = number | null

export interface PollerSchedulerDeps {
  list: () => Promise<SchedulablePoller[]>
  get: (id: string) => Promise<SchedulablePoller | undefined>
  /**
   * Runs the poller once and records the run; resolves with its consecutive failures after it,
   * or null when Seti stopped it. dueAt is when the schedule wanted the run, null on request.
   */
  run: (id: string, trigger: PollerRunTrigger, dueAt: string | null) => Promise<RunEnd>
  setNextRun: (id: string, at: string | null) => Promise<void>
  concurrency: number
  onError: (error: unknown) => void
  /** A poller the watchdog found with no timer or long overdue, and re-armed. */
  onStale: (id: string, reason: string) => void
  now?: () => number
  random?: () => number
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
  /** Calls fn every ms until the returned stop is called; the watchdog's clock. */
  repeat?: (fn: () => void, ms: number) => () => void
}

const BACKOFF_JITTER = 0.1
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000
/** Pollers due while Seti was down start within this, or a quarter interval if that is sooner. */
const STARTUP_SPREAD_MS = 60_000
/** The most a healthy run starts late on purpose, so pollers due together spread out. */
const GRID_JITTER_MS = 5000
/** How soon a poller whose rescheduling failed is tried again. */
const RETRY_MS = 60_000
const WATCH_MS = 60_000
/** How far past one interval a poller's next run may slip before the watchdog re-arms it. */
const WATCH_MARGIN_MS = 60_000

function repeatEvery(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms)
  timer.unref()
  return () => {
    clearInterval(timer)
  }
}

/** After failures: the interval doubled per failure, up to 6 h but not under it, jittered 10%. */
export function backoffDelayMs(intervalS: number, failures: number, random: number): number {
  const base = intervalS * 1000
  const backedOff = Math.min(base * 2 ** Math.min(failures, 16), Math.max(base, BACKOFF_CAP_MS))
  return Math.round(backedOff * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random))
}

/** The first slot after `now` on the grid: the anchor plus whole intervals, missed ones skipped. */
export function nextSlot(anchorMs: number, intervalS: number, now: number): number {
  const step = intervalS * 1000
  return anchorMs + step * Math.max(1, Math.floor((now - anchorMs) / step) + 1)
}

/** The small, random delay a healthy run starts after its slot: 2% of the interval, at most 5 s. */
export const gridJitterMs = (intervalS: number, random: number) =>
  Math.round(random * Math.min(GRID_JITTER_MS, intervalS * 20))

/** The wait at start for a slot missed while Seti was down: under a minute or interval/4. */
export const catchUpDelayMs = (intervalS: number, random: number) =>
  Math.round(random * Math.min(STARTUP_SPREAD_MS, (intervalS * 1000) / 4))

/** Runs at most `limit` jobs at once; the rest wait their turn in order. */
export function createLimiter(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    active += 1
    try {
      return await job()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

/** Why a poll now did not start. */
export class PollerBusyError extends Error {}

/**
 * Polls every enabled poller on a fixed grid of its interval, one run per poller at a time, a few
 * at once. The next slot is stored, so a restart keeps the grid and runs a missed slot only once.
 */
export function createPollerScheduler(deps: PollerSchedulerDeps) {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  const repeat = deps.repeat ?? repeatEvery
  const limit = createLimiter(deps.concurrency)
  const timers = new Map<string, Timer>()
  const busy = new Set<string>()
  let idleWaiters: (() => void)[] = []
  let started = false
  let stopWatch: (() => void) | null = null

  const iso = (ms: number) => new Date(ms).toISOString()

  const unschedule = (id: string) => {
    const timer = timers.get(id)
    if (timer !== undefined) {
      clearTimer(timer)
      timers.delete(id)
    }
  }

  /** Runs the poller after delayMs; dueAt, stored as its next run, says when it was wanted. */
  async function schedule(id: string, delayMs: number, dueAt = iso(now() + Math.max(0, delayMs))): Promise<void> {
    unschedule(id)
    timers.set(
      id,
      setTimer(
        () => {
          timers.delete(id)
          void execute(id, 'schedule', dueAt).catch(deps.onError)
        },
        Math.max(0, delayMs),
      ),
    )
    await deps.setNextRun(id, dueAt).catch(deps.onError)
  }

  /** Schedules the next slot after `anchor` on the poller's grid, a few seconds late at most. */
  async function scheduleSlot(poller: SchedulablePoller, anchorMs: number): Promise<void> {
    const slot = nextSlot(anchorMs, poller.interval_s, now())
    await schedule(poller.id, slot - now() + gridJitterMs(poller.interval_s, random()), iso(slot))
  }

  /** Times the next run: the next slot after this one, or a backoff from now after failures. */
  async function reschedule(id: string, failures: number | null, dueAt: string | null): Promise<void> {
    try {
      const poller = await deps.get(id)
      if (!started || poller?.enabled !== true) {
        return
      }
      const inARow = failures ?? poller.failures
      if (inARow > 0) {
        await schedule(id, backoffDelayMs(poller.interval_s, inARow, random()))
        return
      }
      const stored = poller.next_run_at === null ? Number.NaN : Date.parse(poller.next_run_at)
      if (dueAt === null && stored > now()) {
        await schedule(id, stored - now(), poller.next_run_at ?? undefined)
        return
      }
      await scheduleSlot(poller, Date.parse(dueAt ?? poller.next_run_at ?? iso(now())))
    } catch (e) {
      deps.onError(e)
      if (started) {
        await schedule(id, RETRY_MS)
      }
    }
  }

  function settle(id: string): void {
    busy.delete(id)
    if (busy.size === 0) {
      const waiters = idleWaiters
      idleWaiters = []
      for (const resolve of waiters) {
        resolve()
      }
    }
  }

  /** Runs the poller once; whatever the run does, the poller gets its next run. */
  async function execute(id: string, trigger: PollerRunTrigger, dueAt: string | null): Promise<void> {
    busy.add(id)
    let failures: RunEnd = null
    try {
      failures = await limit(async () => deps.run(id, trigger, dueAt))
    } finally {
      await reschedule(id, failures, dueAt)
      settle(id)
    }
  }

  /** Re-arms enabled pollers with no timer, or whose next run is over an interval overdue. */
  async function watch(): Promise<void> {
    if (!started) {
      return
    }
    for (const poller of await deps.list()) {
      if (!poller.enabled || busy.has(poller.id)) {
        continue
      }
      const lateMs = poller.next_run_at === null ? 0 : now() - Date.parse(poller.next_run_at)
      const overdue = lateMs > poller.interval_s * 1000 + WATCH_MARGIN_MS
      if (timers.has(poller.id) && !overdue) {
        continue
      }
      deps.onStale(
        poller.id,
        overdue ? `its run was ${String(Math.round(lateMs / 1000))} s overdue` : 'it had no timer',
      )
      await schedule(poller.id, 0, poller.next_run_at ?? undefined)
    }
  }

  /** A stored next run keeps its time; one missed while Seti was down runs soon, once. */
  async function scheduleAtStart(poller: SchedulablePoller): Promise<void> {
    const stored = poller.next_run_at === null ? Number.NaN : Date.parse(poller.next_run_at)
    if (stored > now()) {
      await schedule(poller.id, stored - now(), poller.next_run_at ?? undefined)
      return
    }
    await schedule(poller.id, catchUpDelayMs(poller.interval_s, random()), poller.next_run_at ?? undefined)
  }

  /**
   * Applies a poller's settings: a new or resumed poller runs at once and anchors its grid there,
   * a changed interval starts its grid from now, and a paused or deleted poller is dropped.
   */
  async function sync(id: string, fromNow = true): Promise<void> {
    const poller = await deps.get(id)
    if (!started || poller?.enabled !== true) {
      unschedule(id)
      await deps.setNextRun(id, null).catch(() => undefined)
      return
    }
    if (busy.has(id)) {
      return
    }
    if (!fromNow) {
      await scheduleAtStart(poller)
    } else if (poller.next_run_at === null) {
      await schedule(id, 0)
    } else {
      await scheduleSlot(poller, now())
    }
  }

  return {
    sync,
    /** Starts a run now unless one is going; the next scheduled slot keeps its time. */
    pollNow: async (id: string): Promise<void> => {
      if (busy.has(id)) {
        throw new PollerBusyError('This poller is running already')
      }
      unschedule(id)
      await execute(id, 'manual', null)
    },
    /** Takes a slot for a run outside the schedule, such as a test run. */
    withSlot: async <T>(job: () => Promise<T>): Promise<T> => limit(job),
    isRunning: (id: string) => busy.has(id),
    /** Resolves once no run is going, as Seti shuts down. */
    idle: async (): Promise<void> => {
      if (busy.size > 0) {
        await new Promise<void>((resolve) => idleWaiters.push(resolve))
      }
    },
    watch,
    start: async () => {
      started = true
      for (const poller of await deps.list()) {
        await sync(poller.id, false)
      }
      stopWatch ??= repeat(() => {
        void watch().catch(deps.onError)
      }, WATCH_MS)
    },
    stop: () => {
      started = false
      stopWatch?.()
      stopWatch = null
      for (const id of [...timers.keys()]) {
        unschedule(id)
      }
    },
    scheduledIds: () => [...timers.keys()],
  }
}
