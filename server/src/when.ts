const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Follow-ups further out than this belong in a calendar. */
const MAX_AHEAD_MS = 30 * DAY

export class WhenError extends Error {}

const UNITS: Readonly<Record<string, number>> = {
  s: SECOND,
  sec: SECOND,
  second: SECOND,
  m: MINUTE,
  min: MINUTE,
  minute: MINUTE,
  h: HOUR,
  hr: HOUR,
  hour: HOUR,
  d: DAY,
  day: DAY,
  week: 7 * DAY,
}

const COUNT_WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, two: 2, three: 3, half: 0.5 }

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY_WORDS = new Set(['today', 'tonight', 'tomorrow', ...WEEKDAYS])

const NUMBER = /^\d+(?:\.\d+)?$/
const CLOCK = /^(\d{1,2})(?::(\d{2}))?$/
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})$/
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/
const ISO_ZONE = /(?:z|[+-]\d{2}:?\d{2})$/
const UTC_OFFSET = /^(?:utc|gmt)?([+-])(\d{1,2})(?::?(\d{2}))?$/

/** An IANA zone, UTC, or an offset such as UTC+02:00, as Intl names it; throws when unknown. */
export function normaliseZone(zone: string): string {
  const text = zone.trim()
  const lower = text.toLowerCase().replaceAll(' ', '')
  if (lower === 'utc' || lower === 'gmt' || lower === 'z') {
    return 'UTC'
  }
  const offset = UTC_OFFSET.exec(lower)
  const name = offset ? `${offset[1] ?? '+'}${(offset[2] ?? '0').padStart(2, '0')}:${offset[3] ?? '00'}` : text
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
  } catch {
    throw new WhenError(`Unknown timezone ${zone}`)
  }
  return name
}

interface Wall {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

function wallTime(at: Date, zone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'long',
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
    weekday: WEEKDAYS.indexOf(part('weekday').toLowerCase()),
  }
}

const offsetAt = (at: Date, zone: string) => {
  const wall = wallTime(at, zone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  return asUtc - Math.floor(at.getTime() / MINUTE) * MINUTE
}

/** The instant a wall clock time in `zone` names; a time a DST gap skips moves past the gap. */
export function zonedInstant(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  zone: string,
): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  const first = naive - offsetAt(new Date(naive), zone)
  const second = naive - offsetAt(new Date(first), zone)
  return new Date(Math.max(first, second))
}

const amountOf = (token: string) => (NUMBER.test(token) ? Number(token) : (COUNT_WORDS[token] ?? null))

const unitOf = (token: string) => UNITS[token] ?? UNITS[token.replace(/s$/, '')] ?? null

/** Milliseconds in a span such as `20 minutes`, `an hour and 30 minutes` or `1h30m`. */
function span(text: string): number | null {
  const tokens = text
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(' ')
    .filter((token) => token !== '' && token !== 'and')
  let total = 0
  for (let i = 0; i < tokens.length; i += 2) {
    const amount = amountOf(tokens[i] ?? '')
    if (tokens[i] === 'half' && (tokens[i + 1] === 'an' || tokens[i + 1] === 'a')) {
      i++
    }
    const unit = unitOf(tokens[i + 1] ?? '')
    if (amount === null || unit === null) {
      return null
    }
    total += amount * unit
  }
  return total > 0 ? total : null
}

const NAMED_TIMES: Readonly<Record<string, number>> = { noon: 12, midday: 12, midnight: 0 }

function to24h(hour: number, meridiem: string): number | null {
  if (meridiem === '') {
    return hour <= 23 ? hour : null
  }
  if (hour < 1 || hour > 12) {
    return null
  }
  return (hour % 12) + (meridiem === 'pm' ? 12 : 0)
}

function clockTime(text: string): { hour: number; minute: number } | null {
  const named = NAMED_TIMES[text]
  if (named !== undefined) {
    return { hour: named, minute: 0 }
  }
  const compact = text.replaceAll('.', '').replaceAll(' ', '')
  const meridiem = compact.endsWith('am') || compact.endsWith('pm') ? compact.slice(-2) : ''
  const match = CLOCK.exec(compact.slice(0, compact.length - meridiem.length))
  if (match === null) {
    return null
  }
  const hour = to24h(Number(match[1]), meridiem)
  const minute = match[2] === undefined ? 0 : Number(match[2])
  return hour === null || minute > 59 ? null : { hour, minute }
}

const addDays = (wall: Wall, days: number) => {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days))
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

/** `[day] [at] time`, where day is today, tonight, tomorrow or a weekday. */
function dayTime(text: string, zone: string, now: Date): Date | null {
  const words = text.split(' ')
  const dayWord = DAY_WORDS.has(words[0] ?? '') ? words.shift() : undefined
  if (words[0] === 'at') {
    words.shift()
  }
  const timeText = words.join(' ')
  const time = clockTime(timeText === '' && dayWord === 'tonight' ? '9pm' : timeText)
  if (time === null) {
    return null
  }
  const today = wallTime(now, zone)
  const at = (days: number) => zonedInstant(addDays(today, days), time.hour, time.minute, zone)
  if (dayWord === undefined || dayWord === 'today' || dayWord === 'tonight') {
    const same = at(0)
    return same.getTime() > now.getTime() || dayWord !== undefined ? same : at(1)
  }
  if (dayWord === 'tomorrow') {
    return at(1)
  }
  const ahead = (WEEKDAYS.indexOf(dayWord) - today.weekday + 7) % 7
  const sameDay = at(ahead)
  return sameDay.getTime() > now.getTime() ? sameDay : at(ahead + 7)
}

function isoTime(text: string, zone: string): Date | null {
  if (!ISO_PREFIX.test(text)) {
    return null
  }
  const local = ISO_LOCAL.exec(text)
  if (local === null) {
    const parsed = ISO_ZONE.test(text) ? new Date(text.toUpperCase()) : null
    return parsed === null || Number.isNaN(parsed.getTime()) ? null : parsed
  }
  const [year, month, day, hour, minute] = local.slice(1).map(Number)
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) {
    return null
  }
  return zonedInstant({ year, month, day }, hour, minute, zone)
}

/** The instant `when` names in `zone`; throws a WhenError that says what went wrong. */
export function resolveWhen(when: string, zone: string, now: Date): Date {
  const text = when.trim().toLowerCase().replace(/\s+/g, ' ')
  let due: Date | null
  if (text.startsWith('in ')) {
    const ms = span(text.slice(3))
    due = ms === null ? null : new Date(now.getTime() + ms)
  } else {
    due = isoTime(text, zone) ?? dayTime(text, zone, now)
  }
  if (due === null) {
    throw new WhenError(
      `Could not read "${when}". Use a span such as in 20 minutes, a time such as at 15:00 or at 3pm, ` +
        'or a day and time such as tomorrow at 9am.',
    )
  }
  if (due.getTime() < now.getTime() - MINUTE) {
    throw new WhenError(`"${when}" is in the past`)
  }
  if (due.getTime() - now.getTime() > MAX_AHEAD_MS) {
    throw new WhenError(`"${when}" is more than 30 days ahead`)
  }
  return due
}

/** A due time as the user reads it, such as `Monday 15:00 (Europe/Berlin)`. */
export function localLabel(at: Date, zone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at)
  return `${text.replace(',', '')} (${zone})`
}

/** Formats a date as YYYY-MM-DD HH:MM in the given timezone. */
export function localDateTime(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}
