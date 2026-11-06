import { describe, expect, it } from 'vitest'
import { moonLitPath, moonState } from './moon'
import { sunAltitude } from './solar'

const DALLAS = { lat: 32.78, lon: -96.8 }
const BERLIN = { lat: 52.52, lon: 13.4 }

const phaseDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b))

describe('moonState', () => {
  it('puts the moon on the sun during the total solar eclipse of 2024-04-08', () => {
    const at = Date.parse('2024-04-08T18:42:00Z')
    const moon = moonState(at, DALLAS)
    expect(Math.abs(moon.altitude - sunAltitude(at, DALLAS))).toBeLessThan(1.5)
    expect(phaseDistance(moon.phase, 0)).toBeLessThan(0.01)
    expect(moon.lit).toBeLessThan(0.01)
  })

  it('puts the full moon opposite the sun during the lunar eclipse of 2024-09-18', () => {
    const at = Date.parse('2024-09-18T02:44:00Z')
    const moon = moonState(at, BERLIN)
    expect(phaseDistance(moon.phase, 0.5)).toBeLessThan(0.01)
    expect(moon.lit).toBeGreaterThan(0.99)
    expect(Math.abs(moon.altitude + sunAltitude(at, BERLIN))).toBeLessThan(2.5)
  })
})

describe('moonLitPath', () => {
  const terminator = (path: string) => path.split('A')[2]?.split(' ')
  const limbSweep = (path: string) => path.split('A')[1]?.split(' ')[4]

  it('draws a half disc at the quarters, lit right while waxing and left while waning', () => {
    expect(terminator(moonLitPath(0.25, 5))?.[0]).toBe('0.000')
    expect(limbSweep(moonLitPath(0.25, 5))).toBe('1')
    expect(limbSweep(moonLitPath(0.75, 5))).toBe('0')
  })

  it('bows the terminator toward the limb for a crescent and away from it past a quarter', () => {
    const crescent = terminator(moonLitPath(0.1, 5))
    const gibbous = terminator(moonLitPath(0.4, 5))
    expect(Number(crescent?.[0])).toBeCloseTo(5 * Math.cos(0.2 * Math.PI), 3)
    expect(crescent?.[4]).toBe('0')
    expect(gibbous?.[4]).toBe('1')
  })

  it('closes into a full circle at full moon', () => {
    expect(moonLitPath(0.5, 4)).toBe('M0 -4A4 4 0 0 0 0 4A4.000 4 0 0 0 0 -4Z')
  })
})
