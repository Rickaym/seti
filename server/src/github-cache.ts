import { z } from 'zod'
import { fetchPrHeads, gh, type PrHead } from './github.js'
import { cache } from './redis.js'

/** A PR's head branch never changes; a URL that is no PR yet may become one, so it expires. */
const HEAD_TTL_S = 7 * 24 * 60 * 60
const NOT_A_PR_TTL_S = 60 * 60

const headKey = (url: string) => `gh:head:${url}`

/** PR heads from the shared cache, asking GitHub only for the URLs no process has looked up. */
export async function cachedPrHeads(urls: readonly string[]): Promise<Map<string, PrHead | null>> {
  const hits = await cache.getMany<{ head: PrHead | null }>(urls.map(headKey))
  const found = new Map<string, PrHead | null>()
  const missing: string[] = []
  for (const [index, url] of urls.entries()) {
    const hit = hits[index]
    if (hit === undefined) {
      missing.push(url)
    } else {
      found.set(url, hit.head)
    }
  }
  if (missing.length > 0) {
    for (const [url, head] of await fetchPrHeads(missing)) {
      found.set(url, head)
      await cache.set(headKey(url), { head }, head === null ? NOT_A_PR_TTL_S : HEAD_TTL_S)
    }
  }
  return found
}

interface GraphqlBudget {
  remaining: number
  /** Epoch seconds when GitHub refills the budget. */
  reset: number
}

const BUDGET_KEY = 'gh:budget:graphql'
const BUDGET_TTL_S = 60
/** Below this the PR poller waits for the reset, leaving the rest to the user and the PR list. */
export const POLL_BUDGET_FLOOR = 500

let local: { budget: GraphqlBudget; at: number } | null = null

const rateLimit = z.object({ remaining: z.number(), reset: z.number() })

/** GitHub does not charge the budget for reading it. */
async function fetchGraphqlBudget(): Promise<GraphqlBudget> {
  return rateLimit.parse(JSON.parse(await gh(['api', 'rate_limit', '--jq', '.resources.graphql'])))
}

/** The GraphQL budget left, shared by every process for a minute; null when gh cannot tell. */
async function graphqlBudget(now = Date.now()): Promise<GraphqlBudget | null> {
  if (local !== null && now - local.at < BUDGET_TTL_S * 1000) {
    return local.budget
  }
  const shared = await cache.get<GraphqlBudget>(BUDGET_KEY)
  const budget = shared ?? (await fetchGraphqlBudget().catch(() => null))
  if (budget === null) {
    return null
  }
  if (shared === undefined) {
    await cache.set(BUDGET_KEY, { remaining: budget.remaining, reset: budget.reset }, BUDGET_TTL_S)
  }
  local = { budget, at: now }
  return budget
}

/** Whether the PR poller may spend budget now: enough is left, or the budget has refilled. */
export async function canPollGithub(now = Date.now()): Promise<boolean> {
  const budget = await graphqlBudget(now)
  return budget === null || budget.remaining >= POLL_BUDGET_FLOOR || now / 1000 >= budget.reset
}
