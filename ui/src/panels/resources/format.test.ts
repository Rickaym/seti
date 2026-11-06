import { describe, expect, it } from 'vitest'
import { ageLabel, bytesLabel, percentLabel } from '@/panels/resources/format'

describe('resource labels', () => {
  it('writes sizes in binary units', () => {
    expect(bytesLabel(0)).toBe('0 B')
    expect(bytesLabel(312 * 1024 ** 2)).toBe('312 MB')
    expect(bytesLabel(2.5 * 1024 ** 3)).toBe('2.5 GB')
  })

  it('writes percents and ages', () => {
    expect(percentLabel(null)).toBe('-')
    expect(percentLabel(70.4)).toBe('70%')
    expect(ageLabel(42)).toBe('42s')
    expect(ageLabel(725)).toBe('12m')
    expect(ageLabel(3 * 3600 + 5 * 60)).toBe('3h 05m')
    expect(ageLabel(4 * 86_400 + 2 * 3600)).toBe('4d 2h')
  })
})
