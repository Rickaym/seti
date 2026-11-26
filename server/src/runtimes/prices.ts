import { PROVIDERS, type PriceRow, type ProviderId, type RuntimeEvent } from '@seti/shared'

type Usage = Extract<RuntimeEvent, { type: 'usage' }>['usage']

const PER_TOKEN = 1 / 1_000_000

/** The day of a moment as a price row names it, in UTC. */
const dayOf = (at: Date) => at.toISOString().slice(0, 10)

/** The rates in force on the day among a model's rows, oldest first: the last that began by then. */
export const rowOn = <Row extends Pick<PriceRow, 'from'>>(rows: readonly Row[], at: Date): Row | undefined =>
  rows.findLast((row) => row.from === null || row.from <= dayOf(at))

const rowsOf = (provider: ProviderId, model: string): readonly PriceRow[] =>
  Object.entries<readonly PriceRow[]>(PROVIDERS[provider].prices?.models ?? {}).find(([id]) => id === model)?.[1] ?? []

/**
 * The estimated cost of one model call to the provider in US dollars at the rates of its day, or
 * null where the table lacks the model or the provider prices calls itself. Output tokens include
 * reasoning tokens, which providers bill as output.
 */
export function callCost(provider: ProviderId, model: string, usage: Usage, at = new Date()): number | null {
  const row = rowOn(rowsOf(provider, model), at)
  if (row === undefined) {
    return null
  }
  const cached = usage.cacheRead ?? 0
  const { input, cachedInput, output } =
    row.long !== null && usage.input + cached > row.long.above ? row.long.rate : row.short
  return (usage.input * input + cached * cachedInput + usage.output * output) * PER_TOKEN
}
