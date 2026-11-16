import { setTimeout as sleep } from 'node:timers/promises'
import { fetchPrDetails, type OpenPr } from './github.js'
import { prDecorators } from './pr-decorators.js'
import { cache } from './redis.js'

const TTL_MS = 60_000
const SHARED_TTL_S = 60 * 60
/** A URL gh could not answer reads as no PR for this long, then is asked again. */
const FAILURE_TTL_MS = 10_000
/** URLs asked within this window go to GitHub in one query. */
const FLUSH_MS = 25
/** URLs one `resource(url:)` query carries. */
const BATCH = 20

/** The detail of one PR as last read; null while it is not an open PR gh can read. */
interface Detail {
  at: number
  pr: OpenPr | null
}

interface Queued {
  url: string
  settle: () => void
}

const known = new Map<string, Detail>()
const inflight = new Map<string, Promise<void>>()
const fetchedListeners: ((prs: readonly OpenPr[]) => void)[] = []
let queue: Queued[] = []
let timer: NodeJS.Timeout | null = null
let decoratedBy = ''

/** Hears the open PRs of each batch of detail this process read from GitHub. */
export function onDetailsFetched(listener: (prs: readonly OpenPr[]) => void): void {
  fetchedListeners.push(listener)
}

/** Detail another set of mods decorated is dropped, so its previews are read again. */
function syncDecorators(): void {
  const now = prDecorators
    .list()
    .map((entry) => entry.key)
    .join(',')
  if (now !== decoratedBy) {
    decoratedBy = now
    known.clear()
  }
}

/** Versioned so detail cached before a field was added is fetched again. */
const sharedKey = (url: string) => `gh:pr:v1:${decoratedBy}:${url}`

const fresh = (detail: Detail | undefined): boolean => detail !== undefined && Date.now() - detail.at < TTL_MS

function prune(): void {
  const oldest = Date.now() - SHARED_TTL_S * 1000
  for (const [url, detail] of known) {
    if (detail.at < oldest) {
      known.delete(url)
    }
  }
}

async function fetchBatch(batch: readonly Queued[]): Promise<void> {
  const urls = batch.map((item) => item.url)
  try {
    const found = await fetchPrDetails(urls)
    const at = Date.now()
    for (const [url, pr] of found) {
      known.set(url, { at, pr })
      await cache.set(sharedKey(url), { at, pr }, SHARED_TTL_S)
    }
    const open = [...found.values()].filter((pr) => pr !== null)
    for (const listener of fetchedListeners) {
      listener(open)
    }
  } catch {
    const at = Date.now() - TTL_MS + FAILURE_TTL_MS
    for (const url of urls) {
      known.set(url, { at, pr: known.get(url)?.pr ?? null })
    }
  } finally {
    for (const { url, settle } of batch) {
      inflight.delete(url)
      settle()
    }
  }
}

function flush(): void {
  timer = null
  const asked = queue
  queue = []
  prune()
  for (let start = 0; start < asked.length; start += BATCH) {
    void fetchBatch(asked.slice(start, start + BATCH))
  }
}

/** Reads the URL's detail from GitHub with the others asked just now; settles either way. */
async function request(url: string): Promise<void> {
  const running = inflight.get(url)
  if (running !== undefined) {
    return running
  }
  const asked = new Promise<void>((resolve) => {
    queue.push({ url, settle: resolve })
  })
  inflight.set(url, asked)
  timer ??= setTimeout(flush, FLUSH_MS)
  return asked
}

/** Takes detail another process read for the URLs this one has none of. */
async function adoptShared(urls: readonly string[]): Promise<void> {
  const unknown = urls.filter((url) => !known.has(url))
  const shared = await cache.getMany<Detail>(unknown.map(sharedKey))
  for (const [index, url] of unknown.entries()) {
    const detail = shared[index]
    if (detail !== undefined) {
      known.set(url, detail)
    }
  }
}

/** What a lookup answers: the detail read so far, and the URLs GitHub has not answered yet. */
export interface DetailAnswer {
  /** Null for a URL that is not an open PR gh can read. */
  details: Map<string, OpenPr | null>
  pending: string[]
}

/**
 * The detail of each URL: fresh for a minute, then served stale while it is read again. A URL
 * never read waits up to `waitMs` for GitHub and is pending past that.
 */
export async function prDetails(urls: readonly string[], waitMs: number): Promise<DetailAnswer> {
  syncDecorators()
  await adoptShared(urls)
  const waits: Promise<void>[] = []
  for (const url of urls) {
    const detail = known.get(url)
    if (detail === undefined) {
      waits.push(request(url))
    } else if (!fresh(detail)) {
      void request(url)
    }
  }
  if (waits.length > 0) {
    const waited = new AbortController()
    await Promise.race([Promise.all(waits), sleep(waitMs, undefined, { signal: waited.signal }).catch(() => undefined)])
    waited.abort()
  }
  const details = new Map<string, OpenPr | null>()
  const pending: string[] = []
  for (const url of urls) {
    const detail = known.get(url)
    if (detail === undefined) {
      pending.push(url)
    } else {
      details.set(url, detail.pr)
    }
  }
  return { details, pending }
}

/** Reads the detail of the URLs that have none or a stale one, without waiting for it. */
export async function refreshDetails(urls: readonly string[]): Promise<void> {
  syncDecorators()
  await adoptShared(urls)
  for (const url of urls) {
    if (!fresh(known.get(url))) {
      void request(url)
    }
  }
}

/** The detail this process holds for an open PR, however old; null with none. */
export function knownDetail(url: string): OpenPr | null {
  syncDecorators()
  return known.get(url)?.pr ?? null
}

/** Marks a PR's detail stale, so the next read asks GitHub again. */
export async function staleDetail(url: string): Promise<void> {
  const detail = known.get(url)
  if (detail !== undefined) {
    detail.at = 0
  }
  await cache.del(sharedKey(url))
}
