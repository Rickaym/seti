import { describe, expect, it } from 'vitest'
import { nightAt, nightWindow, wallInstant } from './window.js'

const iso = (at: Date) => at.toISOString().slice(0, 16)

describe('wallInstant', () => {
  it('moves a time the clock skips to the first minute after the gap', () => {
    expect(iso(wallInstant('2026-03-29', '02:30', 'Europe/Berlin'))).toBe('2026-03-29T01:00')
    expect(iso(wallInstant('2026-03-08', '02:15', 'America/New_York'))).toBe('2026-03-08T07:00')
  })

  it('takes the first occurrence of a time the clock repeats', () => {
    expect(iso(wallInstant('2026-10-25', '02:30', 'Europe/Berlin'))).toBe('2026-10-25T00:30')
    expect(iso(wallInstant('2026-11-01', '01:30', 'America/New_York'))).toBe('2026-11-01T05:30')
  })

  it('reads an ordinary time in a zone without daylight saving', () => {
    expect(iso(wallInstant('2026-11-24', '01:00', 'Europe/Istanbul'))).toBe('2026-11-23T22:00')
  })
})

describe('nightWindow and nightAt', () => {
  const istanbul = { start: '01:00', end: '05:00', zone: 'Europe/Istanbul' }
  const late = { start: '23:00', end: '03:00', zone: 'Europe/Berlin' }

  it('keeps a window inside one date, and crosses midnight when the end is earlier', () => {
    const night = nightWindow('2026-11-24', istanbul)
    expect([iso(night.start), iso(night.end)]).toEqual(['2026-11-23T22:00', '2026-11-24T02:00'])
    const crossing = nightWindow('2026-11-23', late)
    expect([iso(crossing.start), iso(crossing.end)]).toEqual(['2026-11-23T22:00', '2026-11-24T02:00'])
  })

  it('names the night an instant falls in, by the date its window starts', () => {
    expect(nightAt(new Date('2026-11-23T23:30:00Z'), istanbul)).toBe('2026-11-24')
    expect(nightAt(new Date('2026-11-24T01:30:00Z'), late)).toBe('2026-11-23')
    expect(nightAt(new Date('2026-11-24T12:00:00Z'), istanbul)).toBeNull()
  })

  it('holds across a daylight-saving night', () => {
    const berlin = { start: '01:00', end: '05:00', zone: 'Europe/Berlin' }
    const spring = nightWindow('2026-03-29', berlin)
    expect([iso(spring.start), iso(spring.end)]).toEqual(['2026-03-29T00:00', '2026-03-29T03:00'])
    const autumn = nightWindow('2026-10-25', berlin)
    expect([iso(autumn.start), iso(autumn.end)]).toEqual(['2026-10-24T23:00', '2026-10-25T04:00'])
  })
})
