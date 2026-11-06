import { describe, expect, it } from 'vitest'
import { altitudeAt, arcY, peakAltitude, starField, starlight, sunPath } from './sky'
import { ALTITUDE } from './solar'

const HOUR = 3_600_000
const BERLIN = { lat: 52.52, lon: 13.4 }
const FRAME = { top: 0.1, horizon: 0.6, bottom: 1 }

describe('arcY', () => {
  it('puts the horizon on the horizon line and the yearly peak at the top', () => {
    expect(arcY(0, 60, FRAME)).toBeCloseTo(0.6)
    expect(arcY(60, 60, FRAME)).toBeCloseTo(0.1)
    expect(arcY(30, 60, FRAME)).toBeCloseTo(0.35)
  })

  it('scales the sky below the horizon to the room under the line', () => {
    expect(arcY(-60, 60, FRAME)).toBeCloseTo(1)
    expect(arcY(-30, 60, FRAME)).toBeCloseTo(0.8)
  })

  it('keeps altitudes beyond the peak inside the frame', () => {
    expect(arcY(75, 60, FRAME)).toBeCloseTo(0.1)
    expect(arcY(-89, 60, FRAME)).toBeCloseTo(1)
  })
})

describe('peakAltitude', () => {
  it('is the midsummer noon altitude, capped overhead in the tropics', () => {
    expect(peakAltitude(52.52)).toBeCloseTo(60.92)
    expect(peakAltitude(-33.87)).toBeCloseTo(79.57)
    expect(peakAltitude(10)).toBe(90)
  })
})

describe('sunPath', () => {
  const start = Date.parse('2024-06-20T22:00:00Z')
  const path = sunPath(start, start + 24 * HOUR, BERLIN, 96)

  it('samples the whole day evenly', () => {
    expect(path).toHaveLength(97)
    expect(path[0]?.offset).toBe(0)
    expect(path.at(-1)?.offset).toBe(1)
  })

  it('rises from below the horizon to the midsummer noon and back', () => {
    const altitudes = path.map((sample) => sample.altitude)
    const highest = Math.max(...altitudes)
    const noon = path[altitudes.indexOf(highest)]?.offset ?? 0
    expect(highest).toBeGreaterThan(60)
    expect(noon * 24).toBeGreaterThan(13)
    expect(noon * 24).toBeLessThan(13.5)
    expect(path[0]?.altitude).toBeLessThan(0)
  })

  it('interpolates between samples', () => {
    const between = altitudeAt(path, 0.5 + 1 / 192)
    const low = path[48]?.altitude ?? 0
    const high = path[49]?.altitude ?? 0
    expect(between).toBeCloseTo((low + high) / 2, 6)
    expect(altitudeAt(path, 2)).toBe(path.at(-1)?.altitude)
  })
})

describe('starlight', () => {
  it('fades stars in between civil and nautical twilight', () => {
    expect(starlight(ALTITUDE.civil)).toBe(0)
    expect(starlight(10)).toBe(0)
    expect(starlight(-9)).toBeCloseTo(0.5)
    expect(starlight(ALTITUDE.nautical)).toBe(1)
    expect(starlight(-40)).toBe(1)
  })
})

describe('starField', () => {
  it('is stable and stays inside the sky', () => {
    const stars = starField(40)
    expect(stars).toEqual(starField(40))
    for (const star of stars) {
      expect(star.x).toBeGreaterThanOrEqual(0)
      expect(star.x).toBeLessThan(1)
      expect(star.lift).toBeGreaterThan(0)
      expect(star.lift).toBeLessThanOrEqual(1)
      expect(star.weight).toBeGreaterThan(0)
      expect(star.weight).toBeLessThanOrEqual(1)
    }
  })
})
