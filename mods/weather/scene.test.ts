import { describe, expect, it } from 'vitest'
import { COLUMN, columnAt, columnsOf, samplerOf, seededRandom, type WeatherScene } from './scene'
import { previewReport, weatherField } from './weather'

const START = Date.parse('2026-09-27T22:00:00Z')
const END = START + 24 * 3_600_000

function scene(condition: Parameters<typeof previewReport>[0], altitude: (offset: number) => number): WeatherScene {
  return {
    width: 400,
    height: 48,
    horizon: 32,
    field: weatherField(previewReport(condition, START + 12 * 3_600_000), START, END),
    altitude,
    noon: 0.5,
    stars: [],
    reducedMotion: false,
  }
}

describe('columnsOf', () => {
  it('samples one column every few pixels across the band', () => {
    const columns = columnsOf(scene('rain', () => 30))
    expect(columns.count).toBe(400 / COLUMN + 1)
    expect(columns.kind.every((kind) => kind === 'rain')).toBe(true)
    expect(columns.density[0]).toBeGreaterThan(0)
    expect(columns.meteor.every((chance) => chance === 0)).toBe(true)
  })

  it('offers shooting stars only in the dark, clear parts of the band', () => {
    const night = (offset: number) => (offset < 0.5 ? -30 : 20)
    const clear = columnsOf(scene('clear', night))
    expect(clear.meteor[10]).toBe(1)
    expect(clear.meteor[90]).toBe(0)
    expect(clear.night[10]).toBe(1)
    expect(clear.evening[90]).toBe(1)
    expect(columnsOf(scene('cloudy', night)).meteor.every((chance) => chance === 0)).toBe(true)
  })

  it('marks thunder only in storms', () => {
    expect(columnsOf(scene('thunderstorm', () => 10)).thunder.every((level) => level === 1)).toBe(true)
    expect(columnsOf(scene('heavy_rain', () => 10)).thunder.every((level) => level === 0)).toBe(true)
  })

  it('clamps pixel positions to the band', () => {
    const columns = columnsOf(scene('clear', () => 10))
    expect(columnAt(columns, -50)).toBe(0)
    expect(columnAt(columns, 10_000)).toBe(columns.count - 1)
  })
})

describe('samplerOf', () => {
  it('draws columns in proportion to their weights', () => {
    const sampler = samplerOf(new Float32Array([0, 1, 0, 3]))
    expect(sampler.total).toBe(4)
    expect(sampler.pick(0.1)).toBe(1)
    expect(sampler.pick(0.3)).toBe(3)
    expect(sampler.pick(0.99)).toBe(3)
  })
})

describe('seededRandom', () => {
  it('repeats its sequence for a seed and stays in [0, 1)', () => {
    const a = seededRandom(7)
    const b = seededRandom(7)
    const values = Array.from({ length: 200 }, () => a())
    expect(values).toEqual(Array.from({ length: 200 }, () => b()))
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true)
  })
})
