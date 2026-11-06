import { describe, expect, it } from 'vitest'
import { daylight } from './daylight'

const HOUR = 3_600_000
const BERLIN = { lat: 52.52, lon: 13.4 }
const TROMSO = { lat: 69.65, lon: 18.96 }

const berlinDay = (date: string, offsetHours: number) => {
  const start = Date.parse(`${date}T00:00:00Z`) - offsetHours * HOUR
  return { start, end: start + 24 * HOUR }
}

describe('daylight', () => {
  it('orders the sky from night through dawn, noon and dusk back to night', () => {
    const { start, end } = berlinDay('2024-03-20', 1)
    const day = daylight(start, end, BERLIN)
    expect(day.stops.map((stop) => stop.sky)).toEqual([
      'night',
      'night',
      'twilight',
      'dawn',
      'day',
      'noon',
      'day',
      'dusk',
      'twilight',
      'night',
      'night',
    ])
    const offsets = day.stops.map((stop) => stop.offset)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
    expect(offsets[0]).toBe(0)
    expect(offsets.at(-1)).toBe(1)
  })

  it('places the horizon stops at sunrise and sunset', () => {
    const { start, end } = berlinDay('2024-06-21', 2)
    const day = daylight(start, end, BERLIN)
    const at = (sky: string) => day.stops.find((stop) => stop.sky === sky)?.offset ?? Number.NaN
    expect(at('dawn')).toBeCloseTo(((day.sunrise ?? 0) - start) / (end - start), 6)
    expect(at('dusk')).toBeCloseTo(((day.sunset ?? 0) - start) / (end - start), 6)
    expect((day.sunrise ?? 0) - start).toBeGreaterThan(4.5 * HOUR)
    expect((day.sunrise ?? 0) - start).toBeLessThan(5 * HOUR)
    expect(day.polar).toBeNull()
  })

  it('keeps the sky light all day under the midnight sun', () => {
    const { start, end } = berlinDay('2024-06-21', 2)
    const day = daylight(start, end, TROMSO)
    expect(day.polar).toBe('day')
    expect(day.sunrise).toBeNull()
    expect(day.stops.map((stop) => stop.sky)).not.toContain('night')
    expect(day.stops[0]?.sky).toBe('dusk')
  })

  it('never reaches full day in the polar night', () => {
    const { start, end } = berlinDay('2024-12-21', 1)
    const day = daylight(start, end, TROMSO)
    expect(day.polar).toBe('night')
    expect(day.stops.map((stop) => stop.sky)).toEqual([
      'night',
      'night',
      'twilight',
      'twilight',
      'twilight',
      'night',
      'night',
    ])
  })

  it('stretches stops over a 25 hour day when clocks go back', () => {
    const start = Date.parse('2024-10-26T22:00:00Z')
    const end = start + 25 * HOUR
    const day = daylight(start, end, BERLIN)
    const noon = day.stops.find((stop) => stop.sky === 'noon')?.offset ?? 0
    expect(noon * 25).toBeGreaterThan(12)
    expect(noon * 25).toBeLessThan(13.5)
  })
})
