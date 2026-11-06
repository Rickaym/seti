import { describe, expect, it } from 'vitest'
import { weatherPreview } from './preview'
import type { WeatherReport, WeatherSample } from './report.js'
import {
  clearness,
  haze,
  precipitationOf,
  previewReport,
  smoothstep,
  veiling,
  type WeatherPoint,
  weatherField,
  weatherText,
} from './weather'

const START = Date.parse('2026-09-27T22:00:00Z')
const END = START + 24 * 3_600_000

function sample(at: string, overrides: Partial<WeatherSample> = {}): WeatherSample {
  return {
    at,
    condition: 'clear',
    label: 'Clear',
    temperature: 14.4,
    cloud_cover: 0,
    precipitation: 0,
    wind_speed: 20,
    wind_direction: 270,
    visibility: 20000,
    is_day: true,
    ...overrides,
  }
}

const point = (overrides: Partial<WeatherPoint>): WeatherPoint => ({
  condition: 'clear',
  cover: 0,
  precipitation: 0,
  visibility: 20000,
  ...overrides,
})

describe('weatherField', () => {
  const report: WeatherReport = {
    lat: 52.5,
    lon: 13.4,
    current: sample('2026-09-28T09:30:00Z', { condition: 'rain', label: 'Light rain', cloud_cover: 90 }),
    hours: [
      sample('2026-09-28T06:00:00Z', { cloud_cover: 0 }),
      sample('2026-09-28T12:00:00Z', { condition: 'cloudy', cloud_cover: 100, precipitation: 2, visibility: null }),
    ],
  }
  const field = weatherField(report, START, END)
  const offsetOf = (iso: string) => (Date.parse(iso) - START) / (END - START)

  it('blends the numbers between neighbouring readings and takes the nearer condition', () => {
    const between = field.at(offsetOf('2026-09-28T07:30:00Z'))
    expect(between.cover).toBeCloseTo((0.9 * 1.5) / 3.5)
    expect(between.condition).toBe('clear')
    expect(field.at(offsetOf('2026-09-28T09:00:00Z')).condition).toBe('rain')
  })

  it('places the current reading at its own moment', () => {
    expect(field.at(offsetOf('2026-09-28T09:30:00Z'))).toMatchObject({ condition: 'rain', cover: 0.9 })
  })

  it('holds the first and last readings beyond the ends and keeps known visibility', () => {
    expect(field.at(0).cover).toBe(0)
    expect(field.at(1)).toMatchObject({ condition: 'cloudy', cover: 1, visibility: null })
    expect(field.at(offsetOf('2026-09-28T11:00:00Z')).visibility).toBe(20000)
  })

  it('turns a westerly wind into drift to the right and an easterly one to the left', () => {
    expect(field.drift).toBeCloseTo(20)
    const easterly = weatherField({ ...report, current: { ...report.current, wind_direction: 90 } }, START, END)
    expect(easterly.drift).toBeCloseTo(-20)
  })
})

describe('weather effects', () => {
  it('names what falls for each condition', () => {
    expect(precipitationOf('drizzle')).toBe('drizzle')
    expect(precipitationOf('thunderstorm')).toBe('heavy')
    expect(precipitationOf('sleet')).toBe('sleet')
    expect(precipitationOf('fog')).toBeNull()
  })

  it('hides the stars under overcast and fog but not under a clear sky', () => {
    expect(clearness(point({}))).toBe(1)
    expect(clearness(point({ cover: 1 }))).toBe(0)
    expect(clearness(point({ condition: 'fog', cover: 0.2, visibility: 150 }))).toBeLessThan(0.2)
  })

  it('veils the sun more as the sky closes and storms build', () => {
    expect(veiling(point({}))).toBe(0)
    expect(veiling(point({ cover: 0.5 }))).toBe(0)
    expect(veiling(point({ cover: 1 }))).toBeCloseTo(0.9)
    expect(veiling(point({ condition: 'thunderstorm', cover: 0.6 }))).toBeCloseTo(0.855)
  })

  it('reads haze from visibility and fog', () => {
    expect(haze(point({ visibility: null }))).toBe(0)
    expect(haze(point({ visibility: 800 }))).toBeCloseTo(0.5)
    expect(haze(point({ condition: 'fog', visibility: 100 }))).toBeCloseTo(0.85)
  })

  it('eases between its edges in either direction', () => {
    expect(smoothstep(0, 10, 5)).toBeCloseTo(0.5)
    expect(smoothstep(10, 0, 0)).toBe(1)
    expect(smoothstep(0, 10, -3)).toBe(0)
  })
})

describe('weatherText', () => {
  it('writes the condition and the rounded temperature in Celsius', () => {
    expect(weatherText(sample('2026-09-28T09:00:00Z', { label: 'Light rain', temperature: 13.6 }))).toBe(
      'Light rain, 14 C',
    )
    expect(weatherText(sample('2026-09-28T09:00:00Z', { temperature: -0.3 }))).toBe('Clear, 0 C')
    expect(weatherText(sample('2026-09-28T09:00:00Z', { temperature: 13.6 }), 'F')).toBe('Clear, 56 F')
  })
})

describe('previews', () => {
  it('reads the condition from the query string and ignores unknown ones', () => {
    expect(weatherPreview('?weather=thunderstorm')).toBe('thunderstorm')
    expect(weatherPreview('?weather=tornado')).toBeNull()
    expect(weatherPreview('')).toBeNull()
  })

  it('reports one steady condition over the whole band', () => {
    const now = Date.parse('2026-09-28T11:20:00Z')
    const report = previewReport('snow', now)
    expect(report.current).toMatchObject({ condition: 'snow', label: 'Snow', at: '2026-09-28T11:20:00.000Z' })
    expect(report.hours.at(0)?.at).toBe('2026-09-27T11:00:00.000Z')
    expect(report.hours.at(-1)?.at).toBe('2026-09-29T23:00:00.000Z')
    expect(new Set(report.hours.map((hour) => hour.condition))).toEqual(new Set(['snow']))
  })
})
