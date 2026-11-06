import { describe, expect, it } from 'vitest'
import { localIso } from './clock'

const AT = new Date('2026-09-27T14:30:05Z')

describe('localIso', () => {
  it('writes the local wall time with its offset', () => {
    expect(localIso(AT, 480)).toBe('2026-09-27T22:30:05+08:00')
    expect(localIso(AT, 330)).toBe('2026-09-27T20:00:05+05:30')
    expect(localIso(AT, -570)).toBe('2026-09-27T05:00:05-09:30')
    expect(localIso(AT, 0)).toBe('2026-09-27T14:30:05+00:00')
  })
})
