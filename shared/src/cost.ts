/** Where a stored result keeps what Seti counted its turn as costing, in US dollars. */
export const TURN_COST_KEY = 'seti_turn_cost_usd'

/** A result with the cost Seti counted for its turn. */
export type WithTurnCost<T> = T & Record<typeof TURN_COST_KEY, number>

/** What Seti counted a result's turn as costing; null for a result stored without it. */
export function turnCostOf(result: object): number | null {
  const value = TURN_COST_KEY in result ? result[TURN_COST_KEY] : null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
