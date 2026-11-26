import type { CiState, RequestPrState } from '@seti/shared'
import { z } from 'zod'
import { readRollup, ROLLUP_FIELDS, statusCheckRollup } from './github-checks.js'
import { fetchResources } from './github.js'
import { cache } from './redis.js'

/** A merged or closed PR changes little, so its title and state are read again this rarely. */
const TTL_S = 10 * 60

const FIELDS = `url title state commits(last: 1) { nodes { commit { ${ROLLUP_FIELDS} } } }`

const ghPr = z.object({
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup }) })) }),
})

const STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const

/** A PR's title, whether it is open, merged or closed, and its CI. */
export interface PrState {
  title: string
  state: RequestPrState
  ci: CiState | null
}

function parse(node: unknown): PrState {
  const pr = ghPr.parse(node)
  const rollup = pr.commits.nodes.at(-1)?.commit.statusCheckRollup ?? null
  return { title: pr.title, state: STATES[pr.state], ci: readRollup(rollup).ci }
}

const keyOf = (url: string) => `gh:pr-state:v1:${url}`

/**
 * The title, state and CI of each PR, merged and closed ones included, from the cache or one gh
 * lookup for the rest; a URL that is no PR gh can read is left out.
 */
export async function prStates(urls: readonly string[]): Promise<Map<string, PrState>> {
  const cached = await cache.getMany<PrState>(urls.map(keyOf))
  const found = new Map<string, PrState>()
  urls.forEach((url, index) => {
    const known = cached[index]
    if (known !== undefined) {
      found.set(url, known)
    }
  })
  const missing = urls.filter((url) => !found.has(url))
  if (missing.length > 0) {
    for (const [url, state] of await fetchResources(missing, FIELDS, parse)) {
      if (state !== null) {
        found.set(url, state)
        await cache.set(keyOf(url), state, TTL_S)
      }
    }
  }
  return found
}
