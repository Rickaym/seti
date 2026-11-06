import type { HistoryWindow, HistoryWindowQuery } from '@seti/shared'
import { HttpError } from './http.js'
import { activity, type StoredWindow } from './store/activity.js'
import { localDateTime, normaliseZone, WhenError, zonedInstant } from './when.js'

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/i
const DAY_MS = 86_400_000

interface Day {
  year: number
  month: number
  day: number
}

/** A window resolved to stored times, with how to show its times to the reader. */
export interface ResolvedWindow {
  stored: StoredWindow
  view: HistoryWindow
  zone: string
}

const dayAfter = ({ year, month, day }: Day, days: number): Day => {
  const at = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS)
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() }
}

/** The calendar day a word or a date names in `zone`, or null when the text is not a day. */
function dayOf(text: string, zone: string, now: Date): Day | null {
  const word = text.toLowerCase()
  if (word === 'today' || word === 'yesterday') {
    const [year = 0, month = 0, day = 0] = localDateTime(now, zone).slice(0, 10).split('-').map(Number)
    return dayAfter({ year, month, day }, word === 'today' ? 0 : -1)
  }
  const match = DATE.exec(text)
  return match === null ? null : { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/** The instant one end of a window names; a day as `until` takes in that whole day. */
function instantOf(text: string, end: 'since' | 'until', zone: string, now: Date): Date {
  const day = dayOf(text, zone, now)
  if (day !== null) {
    return zonedInstant(end === 'since' ? day : dayAfter(day, 1), 0, 0, zone)
  }
  const local = LOCAL_TIME.exec(text)
  if (local !== null) {
    const [, year, month, dayText, hour, minute] = local.map(Number)
    return zonedInstant({ year: year ?? 0, month: month ?? 0, day: dayText ?? 0 }, hour ?? 0, minute ?? 0, zone)
  }
  const at = Date.parse(text)
  if (Number.isNaN(at)) {
    throw new HttpError(400, `${text} is not a time; send today, yesterday, a date such as 2026-10-27 or an ISO time.`)
  }
  return new Date(at)
}

/** The timezone to read dates in: the one given, else the user's as Seti stored it, else UTC. */
async function zoneFor(given: string | undefined): Promise<{ zone: string; from: string }> {
  try {
    if (given !== undefined) {
      return { zone: normaliseZone(given), from: 'the request' }
    }
    const stored = await activity.storedZone()
    return stored === null
      ? { zone: 'UTC', from: 'no timezone stored in Seti' }
      : { zone: normaliseZone(stored.zone), from: stored.source }
  } catch (e) {
    if (!(e instanceof WhenError)) {
      throw e
    }
    if (given !== undefined) {
      throw new HttpError(400, e.message)
    }
    return { zone: 'UTC', from: 'no usable timezone stored in Seti' }
  }
}

/** Reads a window's ends in the user's timezone; `fallbackSince` stands in for a missing start. */
export async function resolveWindow(
  query: HistoryWindowQuery,
  fallbackSince?: string,
  now = new Date(),
): Promise<ResolvedWindow> {
  const { zone, from } = await zoneFor(query.timezone)
  const sinceText = query.since ?? fallbackSince
  const since = sinceText === undefined ? null : instantOf(sinceText, 'since', zone, now)
  const until = query.until === undefined ? null : instantOf(query.until, 'until', zone, now)
  if (since !== null && until !== null && until <= since) {
    throw new HttpError(400, 'The window ends before it starts; until must come after since.')
  }
  return {
    stored: { from: since?.toISOString() ?? null, to: until?.toISOString() ?? null },
    view: {
      since: since === null ? null : localDateTime(since, zone),
      until: until === null ? null : localDateTime(until, zone),
      timezone: zone,
      timezone_from: from,
    },
    zone,
  }
}
