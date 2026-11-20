import { describe, expect, it } from 'vitest'
import { parseMemoryForm, sameMemoryForm, STEP_GB, toMemoryForm } from './memory-cap-form'

const onStep = (text: string) => Number.isInteger(Number(text) / STEP_GB)

describe('the memory cap form', () => {
  it('shows a cap equal to its soft cap as one without a soft cap', () => {
    const form = toMemoryForm({ high_mb: 16384, max_mb: 16384, swap_max_mb: 1024 })
    expect(form).toMatchObject({ max: '16', swap: '1', throttle: false })
    expect(parseMemoryForm(form)).toEqual({ cap: { high_mb: 16384, max_mb: 16384, swap_max_mb: 1024 } })
  })

  it('starts the soft cap at two thirds of the RAM cap, on the fields half GB steps', () => {
    for (const gb of [6, 7, 9, 10, 13, 16, 100]) {
      const { high } = toMemoryForm({ high_mb: gb * 1024, max_mb: gb * 1024, swap_max_mb: 1024 })
      expect(onStep(high), `${String(gb)} GB gives ${high}`).toBe(true)
      expect(Number(high)).toBeLessThan(gb)
      expect(Number(high)).toBeGreaterThan((gb * 2) / 3 - STEP_GB)
    }
    expect(toMemoryForm({ high_mb: 16384, max_mb: 16384, swap_max_mb: 1024 }).high).toBe('10.5')
    expect(toMemoryForm({ high_mb: 6144, max_mb: 6144, swap_max_mb: 1024 }).high).toBe('4')
  })

  it('keeps a saved soft cap as it is', () => {
    const form = toMemoryForm({ high_mb: 12288, max_mb: 16384, swap_max_mb: 0 })
    expect(form).toEqual({ max: '16', swap: '0', throttle: true, high: '12' })
    expect(sameMemoryForm(form, { ...form, high: '11' })).toBe(false)
    expect(sameMemoryForm({ ...form, throttle: false }, { ...form, throttle: false, high: '11' })).toBe(true)
  })

  it('refuses a soft cap above the RAM cap and sizes that are not numbers', () => {
    expect(parseMemoryForm({ max: '16', swap: '1', throttle: true, high: '17' })).toEqual({
      error: 'The soft cap cannot be above the RAM cap',
    })
    expect(parseMemoryForm({ max: '', swap: '1', throttle: false, high: '4' })).toEqual({
      error: 'Give each size as a number of GB',
    })
  })
})
