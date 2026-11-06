import { describe, expect, it } from 'vitest'
import { ageLabel, durationLabel, elapsedLabel, relativeTime } from '@/lib/time'

describe('elapsedLabel', () => {
  it.each([
    [-5_000, '0s'],
    [42_900, '42s'],
    [60_000, '1m 00s'],
    [210_000, '3m 30s'],
    [3_599_000, '59m 59s'],
    [3_720_000, '1h 02m'],
  ])('%d ms -> %s', (ms, label) => {
    expect(elapsedLabel(ms)).toBe(label)
  })
})

describe('durationLabel', () => {
  it.each([
    [-60_000, '0m'],
    [25 * 60_000, '25m'],
    [59 * 60_000 + 20_000, '59m'],
    [125 * 60_000, '2h 5m'],
    [(3 * 24 + 4) * 3_600_000, '3d 4h'],
  ])('%d ms -> %s', (ms, label) => {
    expect(durationLabel(ms)).toBe(label)
  })
})

describe('ageLabel', () => {
  const now = Date.parse('2026-01-02T00:00:00Z')
  it.each([
    ['2026-01-02T00:00:30Z', '0s'],
    ['2026-01-01T23:59:18Z', '42s'],
    ['2026-01-01T23:55:00Z', '5m'],
    ['2026-01-01T21:00:00Z', '3h'],
    ['2025-12-30T00:00:00Z', '3d'],
  ])('%s -> %s', (iso, label) => {
    expect(ageLabel(iso, now)).toBe(label)
    expect(relativeTime(iso, now)).toBe(`${label} ago`)
  })
})
