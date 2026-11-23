/** A dream window's wall times: start and end as HH:MM in a named zone. */
export interface WindowSetting {
  start: string
  end: string
  zone: string
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The wall clock in a zone at an instant, as `YYYY-MM-DD HH:MM`. */
export function wallClock(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/** The local date at an instant in a zone, as `YYYY-MM-DD`. */
export const localDate = (at: Date, zone: string) => wallClock(at, zone).slice(0, 10)

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 24 * HOUR).toISOString().slice(0, 10)

/**
 * The instant a wall time on a date happens in a zone. A time the clock repeats takes its first
 * occurrence; one it skips moves to the first minute after the gap.
 */
export function wallInstant(date: string, time: string, zone: string): Date {
  const wall = `${date} ${time}`
  const naive = Date.parse(`${date}T${time}:00Z`)
  const offsets = [-14, -12, -1, 0, 1, 12, 14].map((h) => {
    const probe = new Date(naive + h * HOUR)
    return Date.parse(`${wallClock(probe, zone).replace(' ', 'T')}:00Z`) - probe.getTime()
  })
  const exact = [...new Set(offsets)]
    .map((offset) => naive - offset)
    .filter((at) => wallClock(new Date(at), zone) === wall)
    .sort((a, b) => a - b)
  if (exact[0] !== undefined) {
    return new Date(exact[0])
  }
  let at = naive - Math.max(...offsets)
  while (wallClock(new Date(at), zone) < wall) {
    at += MINUTE
  }
  return new Date(at)
}

/** A night's window in UTC: it starts on the night's date, and ends the next day if end <= start. */
export function nightWindow(night: string, setting: WindowSetting): { start: Date; end: Date } {
  const start = wallInstant(night, setting.start, setting.zone)
  const endDate = setting.end <= setting.start ? addDays(night, 1) : night
  return { start, end: wallInstant(endDate, setting.end, setting.zone) }
}

/**
 * The night whose window holds an instant, or null when none does: the window of the local date,
 * or of the day before when that one crosses midnight.
 */
export function nightAt(at: Date, setting: WindowSetting): string | null {
  const today = localDate(at, setting.zone)
  for (const night of [addDays(today, -1), today]) {
    const { start, end } = nightWindow(night, setting)
    if (at >= start && at < end) {
      return night
    }
  }
  return null
}
