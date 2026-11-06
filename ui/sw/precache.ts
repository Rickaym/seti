export interface Precache {
  version: string
  urls: string[]
  /** Chunks the first page does not load; data-saving clients cache them on first use. */
  lazy: string[]
}

/** Build output under this path has content-hashed names, so one name always means one body. */
export const HASHED_PREFIX = '/assets/'

export const isHashed = (url: string) => url.startsWith(HASHED_PREFIX)

/** API data is private and live, Access owns /cdn-cgi, and share pages are never the app shell. */
const PASS_THROUGH = /^\/(api|cdn-cgi|share)(\/|$)/

/** Paths the worker leaves to the network, offline or not. */
export const passesThrough = (pathname: string) => PASS_THROUGH.test(pathname)

export interface PrecachePlan {
  /** Each url with the name of the existing cache that already holds it. */
  copy: [url: string, cacheName: string][]
  fetch: string[]
}

/**
 * Decides where an install gets each precache file: hashed files come from any cache that holds
 * them, other files always come from the network, and data-saving clients skip lazy chunks.
 */
export function planPrecache(precache: Precache, held: ReadonlyMap<string, string>, saveData: boolean): PrecachePlan {
  const lazy = new Set(precache.lazy)
  const plan: PrecachePlan = { copy: [], fetch: [] }
  for (const url of precache.urls) {
    const cacheName = isHashed(url) ? held.get(url) : undefined
    if (cacheName !== undefined) {
      plan.copy.push([url, cacheName])
    } else if (!saveData || !lazy.has(url)) {
      plan.fetch.push(url)
    }
  }
  return plan
}
