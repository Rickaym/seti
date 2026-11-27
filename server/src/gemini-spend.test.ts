import { describe, expect, it } from 'vitest'
import { geminiTurnCost } from './gemini-spend.js'

const NOV = new Date('2026-11-26T12:00:00Z')
const DEC = new Date('2026-12-01T00:00:00Z')

describe("a Gemini turn's estimated cost", () => {
  it('prices cached tokens apart from the input that counts them, and thoughts as output', () => {
    const usage = { inputTokens: 1_000_000, cachedReadTokens: 400_000, outputTokens: 100_000, thoughtTokens: 100_000 }
    expect(geminiTurnCost('gemini-3.8-flash', usage, NOV)).toBeCloseTo(0.6 * 0.75 + 0.4 * 0.075 + 0.2 * 3.75, 10)
  })

  it('takes the rise Google announced from its day on, and not before', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 }
    expect(geminiTurnCost('gemini-4-argon', usage, NOV)).toBeCloseTo(2, 10)
    expect(geminiTurnCost('gemini-4-argon', usage, DEC)).toBeCloseTo(4, 10)
  })

  it("applies Gemini 3.1 Pro's long-context rates past 200k input tokens", () => {
    const usage = { inputTokens: 300_000, outputTokens: 0 }
    expect(geminiTurnCost('gemini-3.1-pro-preview', usage, NOV)).toBeCloseTo(0.3 * 4, 10)
  })

  it('is unknown for a model the table lacks', () => {
    expect(geminiTurnCost('gemini-0', { inputTokens: 1, outputTokens: 1 }, NOV)).toBeNull()
  })
})
