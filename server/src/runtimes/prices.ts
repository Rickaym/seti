import { PROVIDERS, type ProviderId, type RuntimeEvent } from '@seti/shared'

type Usage = Extract<RuntimeEvent, { type: 'usage' }>['usage']

const PER_TOKEN = 1 / 1_000_000

/**
 * The estimated cost of one model call to the provider in US dollars, or null where its table
 * lacks the model or it prices calls itself. Output tokens include reasoning tokens, which
 * providers bill as output.
 */
export function callCost(provider: ProviderId, model: string, usage: Usage): number | null {
  const table = PROVIDERS[provider].prices
  const price = table === null ? undefined : Object.entries(table.models).find(([id]) => id === model)?.[1]
  if (table === null || price === undefined) {
    return null
  }
  const cached = usage.cacheRead ?? 0
  const { input, cachedInput, output } = usage.input + cached > table.longContextAbove ? price.long : price.short
  return (usage.input * input + cached * cachedInput + usage.output * output) * PER_TOKEN
}
