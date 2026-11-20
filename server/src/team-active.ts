import { activity } from './store/activity.js'
import { teamActivity } from './store/team.js'
import { localDateTime, normaliseZone, WhenError, zonedInstant } from './when.js'

const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The zone "today" is read in: the user's as Seti last stored it, else the Seti host's. */
export async function todayZone(): Promise<string> {
  const stored = await activity.storedZone()
  if (stored !== null) {
    try {
      return normaliseZone(stored.zone)
    } catch (e) {
      if (!(e instanceof WhenError)) {
        throw e
      }
    }
  }
  return hostZone()
}

/** The local midnight that starts the day `at` falls on in `zone`. */
export function startOfDay(at: Date, zone: string): Date {
  const [year = 0, month = 0, day = 0] = localDateTime(at, zone).slice(0, 10).split('-').map(Number)
  return zonedInstant({ year, month, day }, 0, 0, zone)
}

/** Agents that are not archived and started, ran a turn or run since local midnight. */
export async function activeToday(at = new Date()): Promise<Set<string>> {
  const since = startOfDay(at, await todayZone()).toISOString()
  return new Set(await teamActivity.activeSince(since))
}
