import { describe, expect, it } from 'vitest'
import { localDateTime, localLabel, normaliseZone, resolveWhen, WhenError, zonedInstant } from './when.js'

/** Monday 28 September 2026, 14:05 in Berlin (UTC+2). */
const NOW = new Date('2026-09-28T12:05:00.000Z')
const BERLIN = 'Europe/Berlin'

const due = (when: string, zone = BERLIN, now = NOW) => resolveWhen(when, zone, now).toISOString()

describe('resolveWhen', () => {
  it('adds relative spans, including words and combined units', () => {
    expect(due('in 20 minutes')).toBe('2026-09-28T12:25:00.000Z')
    expect(due('in an hour')).toBe('2026-09-28T13:05:00.000Z')
    expect(due('in half an hour')).toBe('2026-09-28T12:35:00.000Z')
    expect(due('in 1 hour and 30 minutes')).toBe('2026-09-28T13:35:00.000Z')
    expect(due('in 1h30m')).toBe('2026-09-28T13:35:00.000Z')
    expect(due('in 45 seconds')).toBe('2026-09-28T12:05:45.000Z')
    expect(due('In 2 Days')).toBe('2026-09-30T12:05:00.000Z')
  })

  it('reads clock times in the user timezone, today when still ahead, else tomorrow', () => {
    expect(due('at 15:00')).toBe('2026-09-28T13:00:00.000Z')
    expect(due('at 3pm')).toBe('2026-09-28T13:00:00.000Z')
    expect(due('3:30 pm')).toBe('2026-09-28T13:30:00.000Z')
    expect(due('at 9am')).toBe('2026-09-29T07:00:00.000Z')
    expect(due('noon')).toBe('2026-09-29T10:00:00.000Z')
    expect(due('at 15:00', 'Asia/Singapore')).toBe('2026-09-29T07:00:00.000Z')
    expect(due('at 21:00', 'Asia/Singapore')).toBe('2026-09-28T13:00:00.000Z')
    expect(due('at 15:00', normaliseZone('UTC+05:30'))).toBe('2026-09-29T09:30:00.000Z')
  })

  it('reads days: tomorrow, tonight and weekdays', () => {
    expect(due('tomorrow at 9am')).toBe('2026-09-29T07:00:00.000Z')
    expect(due('tomorrow 18:15')).toBe('2026-09-29T16:15:00.000Z')
    expect(due('tonight')).toBe('2026-09-28T19:00:00.000Z')
    expect(due('wednesday at 10:00')).toBe('2026-09-30T08:00:00.000Z')
    expect(due('monday at 10:00')).toBe('2026-10-05T08:00:00.000Z')
    expect(due('monday at 16:00')).toBe('2026-09-28T14:00:00.000Z')
  })

  it('takes ISO times, local to the zone unless they carry an offset', () => {
    expect(due('2026-09-28T18:00')).toBe('2026-09-28T16:00:00.000Z')
    expect(due('2026-09-28T18:00:00Z')).toBe('2026-09-28T18:00:00.000Z')
    expect(due('2026-09-28T18:00+01:00')).toBe('2026-09-28T17:00:00.000Z')
  })

  it('follows daylight saving: across the change, and past a skipped hour', () => {
    const march = new Date('2026-03-28T12:00:00.000Z')
    expect(due('tomorrow at 9am', BERLIN, march)).toBe('2026-03-29T07:00:00.000Z')
    expect(zonedInstant({ year: 2026, month: 3, day: 29 }, 2, 30, BERLIN).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    )
    const october = new Date('2026-10-24T12:00:00.000Z')
    expect(due('tomorrow at 9am', BERLIN, october)).toBe('2026-10-25T08:00:00.000Z')
  })

  it('refuses the past, the far future and what it cannot read', () => {
    expect(() => resolveWhen('2026-09-28T10:00', BERLIN, NOW)).toThrow(/in the past/)
    expect(() => resolveWhen('in 40 days', BERLIN, NOW)).toThrow(/more than 30 days/)
    expect(() => resolveWhen('whenever you like', BERLIN, NOW)).toThrow(WhenError)
    expect(() => resolveWhen('at 25:00', BERLIN, NOW)).toThrow(WhenError)
    expect(() => resolveWhen('in 5 fortnights', BERLIN, NOW)).toThrow(WhenError)
  })
})

describe('zones and labels', () => {
  it('names zones as Intl does and refuses unknown ones', () => {
    expect(normaliseZone('utc')).toBe('UTC')
    expect(normaliseZone('UTC+05:30')).toBe('+05:30')
    expect(normaliseZone('-3')).toBe('-03:00')
    expect(normaliseZone('Europe/Berlin')).toBe('Europe/Berlin')
    expect(() => normaliseZone('Mars/Olympus')).toThrow(/Unknown timezone/)
  })

  it('labels a due time with its weekday, clock and zone', () => {
    expect(localLabel(new Date('2026-09-28T13:00:00.000Z'), BERLIN)).toBe('Monday 15:00 (Europe/Berlin)')
  })

  it('formats a date as local date and time in a zone', () => {
    expect(localDateTime(NOW, 'America/New_York')).toBe('2026-09-28 08:05')
  })
})
