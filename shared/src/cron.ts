import { Cron } from 'croner'
import { z } from 'zod'

interface ScheduleIssue {
  path: 'cron' | 'timezone'
  message: string
}

function timezoneIssue(timezone: string): ScheduleIssue | null {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return null
  } catch {
    return { path: 'timezone', message: `Unknown timezone "${timezone}", use an IANA name like Europe/Berlin` }
  }
}

const croner = (cron: string, timezone: string) => new Cron(cron, { timezone, mode: '5-part' })

/** Next run times as ISO strings; assumes the schedule already passed scheduleIssue. */
export function nextRunTimes(cron: string, timezone: string, count: number, from?: Date): string[] {
  return croner(cron, timezone)
    .nextRuns(count, from)
    .map((date) => date.toISOString())
}

/** How many slots fall after `from` and at or before `to`, counting at most `max`. */
export function runsBetween(cron: string, timezone: string, range: { from: Date; to: Date }, max: number): number {
  const job = croner(cron, timezone)
  let count = 0
  for (let at = job.nextRun(range.from); at !== null && at <= range.to && count < max; at = job.nextRun(at)) {
    count += 1
  }
  return count
}

/** The newest slot at or before `at`, or null when the schedule has none. */
export function previousRunTime(cron: string, timezone: string, at: Date): string | null {
  // croner counts whole seconds and returns slots before the second of its reference time
  const [slot] = croner(cron, timezone).previousRuns(1, new Date(at.getTime() + 1000))
  return slot === undefined ? null : slot.toISOString()
}

/** Returns why a 5-field cron expression and IANA timezone cannot be used, or null when they can. */
export function scheduleIssue(cron: string, timezone: string): ScheduleIssue | null {
  const tz = timezoneIssue(timezone)
  if (tz) {
    return tz
  }
  if (cron.trim().split(/\s+/).length !== 5) {
    return { path: 'cron', message: 'Schedule needs 5 fields: minute hour day-of-month month day-of-week' }
  }
  try {
    if (nextRunTimes(cron, timezone, 1).length === 0) {
      return { path: 'cron', message: 'Schedule never runs' }
    }
    return null
  } catch (e) {
    const detail = e instanceof Error ? e.message.replace(/^Cron\w*: /, '') : String(e)
    return { path: 'cron', message: `Invalid schedule: ${detail}` }
  }
}

/** A 5-field cron expression read in an IANA timezone. */
export const cronSchedule = z
  .object({
    cron: z.string().trim().min(1, 'cron is required'),
    timezone: z.string().trim().min(1, 'timezone is required'),
  })
  .superRefine((value, ctx) => {
    const issue = scheduleIssue(value.cron, value.timezone)
    if (issue) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message })
    }
  })
export type CronSchedule = z.output<typeof cronSchedule>
