import { activity } from './store/activity.js'
import { teamMembers } from './store/team.js'
import { localDateTime, normaliseZone, WhenError, zonedInstant } from './when.js'

const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The timezone @active counts the day in: the user's as Seti stored it, else the Seti host's. */
export async function teamZone(): Promise<string> {
  const stored = await activity.storedZone()
  if (stored === null) {
    return hostZone()
  }
  try {
    return normaliseZone(stored.zone)
  } catch (e) {
    if (e instanceof WhenError) {
      return hostZone()
    }
    throw e
  }
}

/** The instant the calendar day holding `at` began in `zone`, as an ISO time. */
export function dayStart(at: number, zone: string): string {
  const [year = 0, month = 0, day = 0] = localDateTime(new Date(at), zone).slice(0, 10).split('-').map(Number)
  return zonedInstant({ year, month, day }, 0, 0, zone).toISOString()
}

/** Tasks that started a turn on today's date in the user's timezone: those @active reaches. */
export async function workedToday(at = Date.now()): Promise<Set<string>> {
  return new Set(await teamMembers.workedSince(dayStart(at, await teamZone())))
}
