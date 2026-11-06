import { describe, expect, it } from 'vitest'
import { usd } from '@/lib/money'

describe('usd', () => {
  it('rounds to the cent with thousands separators', () => {
    expect(usd(0)).toBe('$0.00')
    expect(usd(0.125)).toBe('$0.13')
    expect(usd(5482.123)).toBe('$5,482.12')
  })

  it('shows a cost under half a cent as under a cent rather than nothing', () => {
    expect(usd(0.004)).toBe('<$0.01')
  })

  it('shows a dash for an amount that is not a number', () => {
    expect(usd(Number.NaN)).toBe('-')
  })
})
