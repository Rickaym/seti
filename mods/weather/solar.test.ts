import { describe, expect, it } from 'vitest'
import { ALTITUDE, crossing, solarNoon, sunAltitude } from './solar'

const MINUTE = 60_000
const TOLERANCE_MINUTES = 3

interface Reference {
  city: string
  lat: number
  lon: number
  /** Any instant on the local day. */
  on: string
  sunrise: string
  sunset: string
}

// Published sunrise and sunset times for these days, in UTC.
const REFERENCES: Reference[] = [
  {
    city: 'London midsummer',
    lat: 51.51,
    lon: -0.13,
    on: '2024-06-21T12:00:00Z',
    sunrise: '2024-06-21T03:43:00Z',
    sunset: '2024-06-21T20:21:00Z',
  },
  {
    city: 'New York midwinter',
    lat: 40.71,
    lon: -74.01,
    on: '2024-12-21T17:00:00Z',
    sunrise: '2024-12-21T12:16:00Z',
    sunset: '2024-12-21T21:32:00Z',
  },
  {
    city: 'Sydney midsummer',
    lat: -33.87,
    lon: 151.21,
    on: '2024-12-21T02:00:00Z',
    sunrise: '2024-12-20T18:41:00Z',
    sunset: '2024-12-21T09:05:00Z',
  },
  {
    city: 'Tokyo equinox',
    lat: 35.68,
    lon: 139.69,
    on: '2024-03-20T03:00:00Z',
    sunrise: '2024-03-19T20:45:00Z',
    sunset: '2024-03-20T08:53:00Z',
  },
]

const minutesApart = (a: number, b: string) => Math.abs(a - Date.parse(b)) / MINUTE

describe('solar times', () => {
  it.each(REFERENCES)('match published sunrise and sunset for $city', (ref) => {
    const point = { lat: ref.lat, lon: ref.lon }
    const times = crossing(solarNoon(Date.parse(ref.on), point), point, ALTITUDE.horizon)
    expect(times).not.toBeNull()
    expect(minutesApart(times?.rise ?? 0, ref.sunrise)).toBeLessThan(TOLERANCE_MINUTES)
    expect(minutesApart(times?.set ?? 0, ref.sunset)).toBeLessThan(TOLERANCE_MINUTES)
  })

  it('picks the solar noon of the local day even far from Greenwich', () => {
    const apia = { lat: -13.83, lon: -171.76 }
    const localNoon = Date.parse('2024-06-21T23:00:00Z')
    expect(Math.abs(solarNoon(localNoon, apia) - localNoon) / MINUTE).toBeLessThan(60)
  })

  it('puts the sun highest at solar noon', () => {
    const point = { lat: 51.51, lon: -0.13 }
    const noon = solarNoon(Date.parse('2024-06-21T12:00:00Z'), point)
    expect(sunAltitude(noon, point)).toBeCloseTo(90 - 51.51 + 23.44, 0)
    expect(sunAltitude(noon - 30 * MINUTE, point)).toBeLessThan(sunAltitude(noon, point))
    expect(sunAltitude(noon + 12 * 60 * MINUTE, point)).toBeLessThan(ALTITUDE.nautical)
  })

  it('returns null when the sun never crosses the altitude', () => {
    const tromso = { lat: 69.65, lon: 18.96 }
    expect(crossing(solarNoon(Date.parse('2024-06-21T11:00:00Z'), tromso), tromso, ALTITUDE.horizon)).toBeNull()
    expect(crossing(solarNoon(Date.parse('2024-12-21T11:00:00Z'), tromso), tromso, ALTITUDE.horizon)).toBeNull()
  })
})
