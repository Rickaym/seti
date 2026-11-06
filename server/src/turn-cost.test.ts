import { describe, expect, it } from 'vitest'
import { countResult, type SessionTotal } from './turn-cost.js'

/** Counts results in order as the runner does, one session total carried between them. */
function countAll(results: readonly [string, number][]) {
  const costs: (number | null)[] = []
  let last: SessionTotal | null = null
  for (const [session, total] of results) {
    const counted = countResult(last, session, total)
    costs.push(counted.cost)
    last = counted.last
  }
  const sum = costs.reduce<number>((total, cost) => total + (cost ?? 0), 0)
  return { costs: costs.map((cost) => (cost === null ? null : Number(cost.toFixed(4)))), sum, last }
}

describe('countResult', () => {
  it('counts what the running total grew by, not the total of each turn', () => {
    const { costs, sum, last } = countAll([
      ['a', 0.1],
      ['a', 0.3],
      ['a', 0.6],
    ])
    expect(costs).toEqual([0.1, 0.2, 0.3])
    expect(sum).toBeCloseTo(0.6)
    expect(last).toEqual({ session_id: 'a', total_usd: 0.6 })
  })

  it('carries on from the saved total when a resumed process restores it', () => {
    const { sum } = countAll([
      ['a', 0.1],
      ['a', 0.3],
      ['a', 0.75],
      ['a', 0.9],
    ])
    expect(sum).toBeCloseTo(0.9)
  })

  it('counts a fresh session from zero', () => {
    expect(
      countAll([
        ['a', 0.5],
        ['b', 0.2],
        ['b', 0.25],
      ]).costs,
    ).toEqual([0.5, 0.2, 0.05])
  })

  it('never counts more than was spent when a restored total is older than the last one', () => {
    // Spent 0.1, 0.2, 0.2, then 0.05 and 0.1 after a restart that restored the first total.
    const { costs, sum } = countAll([
      ['a', 0.1],
      ['a', 0.3],
      ['a', 0.5],
      ['a', 0.15],
      ['a', 0.25],
    ])
    expect(costs).toEqual([0.1, 0.2, 0.2, null, 0.1])
    expect(sum).toBeLessThanOrEqual(0.65)
  })

  it('leaves the turn of a reset total unknown and counts from it after', () => {
    expect(
      countAll([
        ['a', 2],
        ['a', 0.4],
        ['a', 0.9],
      ]).costs,
    ).toEqual([2, null, 0.5])
  })

  it('skips the zeroed result of a process that failed to start', () => {
    const { costs, last } = countAll([
      ['a', 0.4],
      ['a', 0],
      ['a', 0.5],
    ])
    expect(costs).toEqual([0.4, null, 0.1])
    expect(last).toEqual({ session_id: 'a', total_usd: 0.5 })
  })

  it('counts a turn that made no model call as free', () => {
    expect(countResult({ session_id: 'a', total_usd: 1 }, 'a', 1).cost).toBe(0)
  })

  it('takes a total that grew past what Seti saw as spend it missed, such as a cut turn', () => {
    expect(countResult({ session_id: 'a', total_usd: 1 }, 'a', 1.6).cost).toBeCloseTo(0.6)
  })

  it('ignores totals that are not numbers', () => {
    expect(countResult(null, 'a', Number.NaN)).toEqual({ cost: null, last: null })
  })
})
