import { PROVIDERS, reachesProvider } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { callCost } from './prices.js'

describe('the provider registry', () => {
  it("lists each provider's API host among the hosts its key is added on", () => {
    for (const provider of Object.values(PROVIDERS)) {
      expect(provider.hosts).toContain(new URL(provider.baseUrl).hostname)
    }
  })

  it("finds a provider's key only on a connection whose hosts reach its model calls", () => {
    expect(reachesProvider('openai', ['*.openai.com'])).toBe(true)
    expect(reachesProvider('openai', ['api.stripe.com', 'api.openai.com'])).toBe(true)
    expect(reachesProvider('openai', ['api.anthropic.com'])).toBe(false)
    expect(reachesProvider('anthropic', ['api.openai.com'])).toBe(false)
  })
})

describe("a model call's estimated cost", () => {
  it('prices input, cached input and output at the short context rates', () => {
    const usd = callCost('openai', 'gpt-5.5', { input: 100_000, cacheRead: 100_000, output: 10_000 })
    expect(usd).toBeCloseTo(0.5 + 0.05 + 0.3, 10)
  })

  it('switches to the long context rates once input and cached input pass the line', () => {
    const usd = callCost('openai', 'gpt-5.5', { input: 200_000, cacheRead: 100_000, output: 10_000 })
    expect(usd).toBeCloseTo(2 + 0.1 + 0.45, 10)
  })

  it('is unknown for a model the table lacks and for a provider that prices its own calls', () => {
    expect(callCost('openai', 'gpt-0', { input: 1, output: 1 })).toBeNull()
    expect(callCost('anthropic', 'claude-opus-5-5', { input: 1, output: 1 })).toBeNull()
  })
})
