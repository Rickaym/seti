import type { RuntimeEvent } from '@seti/shared'

/** US dollars per million tokens. */
interface Rate {
  input: number
  cachedInput: number
  output: number
}

/** Standard-tier rates for the models the pinned Codex lists, at short and long context. */
interface ModelPrice {
  short: Rate
  long: Rate
}

const rate = (input: number, cachedInput: number, output: number): Rate => ({ input, cachedInput, output })

/** OpenAI's public prices as read on `asOf`; an estimate, since the bill is OpenAI's. */
const CODEX_PRICES = {
  asOf: '2026-11-24',
  source: 'https://developers.openai.com/api/docs/pricing',
  /** Input tokens in one model call above which the long context rates apply. */
  longContextAbove: 272_000,
  models: {
    'gpt-5.5': { short: rate(5, 0.5, 30), long: rate(10, 1, 45) },
    'gpt-5.6-luna': { short: rate(0.2, 0.02, 1.2), long: rate(0.4, 0.04, 1.8) },
    'gpt-5.6-sol': { short: rate(4, 0.4, 20), long: rate(8, 0.8, 30) },
    'gpt-5.6-terra': { short: rate(2, 0.2, 12), long: rate(4, 0.4, 18) },
    'gpt-6-astra': { short: rate(10, 1, 50), long: rate(20, 2, 75) },
    'gpt-6-luna': { short: rate(0.1, 0.01, 0.5), long: rate(0.2, 0.02, 0.75) },
    'gpt-6-sol': { short: rate(2, 0.2, 10), long: rate(4, 0.4, 15) },
    'gpt-6.1-sol': { short: rate(2, 0.1, 10), long: rate(4, 0.2, 15) },
    'gpt-6.1-terra': { short: rate(1, 0.05, 5), long: rate(2, 0.1, 7.5) },
    'gpt-6.2-astra': { short: rate(8, 0.4, 40), long: rate(16, 0.8, 60) },
    'gpt-6.2-sol': { short: rate(2, 0.1, 10), long: rate(4, 0.2, 15) },
  } satisfies Record<string, ModelPrice>,
}

/** The day the price table was read, which the estimate names. */
export const PRICES_AS_OF = CODEX_PRICES.asOf

type Usage = Extract<RuntimeEvent, { type: 'usage' }>['usage']

const PER_TOKEN = 1 / 1_000_000

const priceOf = (model: string): ModelPrice | undefined =>
  Object.entries(CODEX_PRICES.models).find(([id]) => id === model)?.[1]

/**
 * The estimated cost of one model call in US dollars, or null for a model the table lacks.
 * Output tokens include reasoning tokens, which OpenAI bills as output.
 */
export function callCost(model: string, usage: Usage): number | null {
  const price = priceOf(model)
  if (price === undefined) {
    return null
  }
  const cached = usage.cacheRead ?? 0
  const { input, cachedInput, output } = usage.input + cached > CODEX_PRICES.longContextAbove ? price.long : price.short
  return (usage.input * input + cached * cachedInput + usage.output * output) * PER_TOKEN
}
