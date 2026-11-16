import { nextRunTimes, runsBetween, type CronSchedule } from './cron.js'

/** What decides when a poller or reminder runs: a cron schedule replaces the interval while set. */
export interface RunTiming {
  interval_s: number
  schedule?: CronSchedule | null
  /** The stored next run; null while paused, which leaves nothing to come. */
  next_run_at: string | null
}

/** A span of time: runs after `from` and at or before `to` fall in it. */
export interface RunRange {
  from: Date
  to: Date
}

export interface RangeRuns {
  count: number
  /** The first run times in the range, soonest first, as ISO strings. */
  times: string[]
}

/** How many next runs a poller or reminder reports with its info. */
export const UPCOMING_RUNS = 5

/** Cron slots counted per range at most: a day of every minute, with room for a clock change. */
const MAX_SLOTS = 26 * 60

/** The first slot after `fromMs` on the grid an interval keeps from its stored next run. */
function firstIntervalRun(nextMs: number, stepMs: number, fromMs: number): number {
  return nextMs > fromMs ? nextMs : nextMs + (Math.floor((fromMs - nextMs) / stepMs) + 1) * stepMs
}

const isoTimes = (firstMs: number, stepMs: number, count: number) =>
  Array.from({ length: count }, (_, i) => new Date(firstMs + i * stepMs).toISOString())

/** The next `count` runs after `from`; an interval's are projected from its stored next run. */
export function nextRuns(timing: RunTiming, from: Date, count: number): string[] {
  if (timing.next_run_at === null) {
    return []
  }
  const schedule = timing.schedule ?? null
  if (schedule !== null) {
    return nextRunTimes(schedule.cron, schedule.timezone, count, from)
  }
  const stepMs = timing.interval_s * 1000
  return isoTimes(firstIntervalRun(Date.parse(timing.next_run_at), stepMs, from.getTime()), stepMs, count)
}

/** The runs in a range of at most a day: how many, and the first `list` of their times. */
export function runsInRange(timing: RunTiming, range: RunRange, list: number): RangeRuns {
  if (timing.next_run_at === null) {
    return { count: 0, times: [] }
  }
  const schedule = timing.schedule ?? null
  if (schedule !== null) {
    const count = runsBetween(schedule.cron, schedule.timezone, range, MAX_SLOTS)
    return { count, times: nextRunTimes(schedule.cron, schedule.timezone, Math.min(count, list), range.from) }
  }
  const stepMs = timing.interval_s * 1000
  const firstMs = firstIntervalRun(Date.parse(timing.next_run_at), stepMs, range.from.getTime())
  const count = firstMs > range.to.getTime() ? 0 : Math.floor((range.to.getTime() - firstMs) / stepMs) + 1
  return { count, times: isoTimes(firstMs, stepMs, Math.min(count, list)) }
}
