import { prLookupSchema, type PullRequest } from '@seti/shared'
import { apiPost, readResponse } from '@/api'

/** Where one PR's status stands: not answered yet, known, or not an open PR GitHub shows. */
export type PrStatus = { state: 'loading' } | { state: 'ready'; pr: PullRequest } | { state: 'none' }

/** URLs asked within this window go to the server in one request. */
const BATCH_MS = 30
/** URLs one request carries. */
const CHUNK = 200
/** Watched statuses are asked again this often while the page is on screen. */
const REFRESH_MS = 60_000
const RETRY_MS = [1500, 3000, 6000, 12_000, 30_000] as const

const LOADING: PrStatus = { state: 'loading' }
const NONE: PrStatus = { state: 'none' }

const statuses = new Map<string, PrStatus>()
const watched = new Map<string, number>()
const listeners = new Set<() => void>()
let queued = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let retries = 0
let version = 0

function changed(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

/** Asks again, each time later, for the URLs the server had no answer for. */
function retry(urls: readonly string[]): void {
  const still = urls.filter((url) => watched.has(url))
  if (still.length === 0) {
    return
  }
  const delay = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)]
  retries += 1
  for (const url of still) {
    queued.add(url)
  }
  retryTimer ??= setTimeout(() => {
    retryTimer = null
    void flush()
  }, delay)
}

async function askChunk(urls: readonly string[]): Promise<string[]> {
  try {
    const body = await apiPost<unknown>('/prs/lookup', { urls })
    const { prs, pending } = readResponse('/prs/lookup', prLookupSchema, body)
    const found = new Map(prs.map((pr) => [pr.url, pr]))
    const waiting = new Set(pending)
    for (const url of urls) {
      const pr = found.get(url)
      if (pr !== undefined) {
        statuses.set(url, { state: 'ready', pr })
      } else if (!waiting.has(url)) {
        statuses.set(url, NONE)
      }
    }
    return pending.filter((url) => urls.includes(url))
  } catch {
    // A failed request keeps what is shown and is asked again like a pending answer.
    return [...urls]
  }
}

async function flush(): Promise<void> {
  flushTimer = null
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  const urls = [...queued].filter((url) => watched.has(url))
  queued = new Set()
  if (urls.length === 0) {
    return
  }
  const chunks = Array.from({ length: Math.ceil(urls.length / CHUNK) }, (_, n) =>
    urls.slice(n * CHUNK, (n + 1) * CHUNK),
  )
  const unanswered = (await Promise.all(chunks.map(askChunk))).flat()
  if (unanswered.length === 0) {
    retries = 0
  }
  changed()
  retry(unanswered)
}

function ask(urls: Iterable<string>): void {
  for (const url of urls) {
    queued.add(url)
  }
  flushTimer ??= setTimeout(() => void flush(), BATCH_MS)
}

const refreshWatched = () => {
  if (document.visibilityState === 'visible') {
    ask(watched.keys())
  }
}

function startRefreshing(): void {
  if (refreshTimer === null) {
    refreshTimer = setInterval(refreshWatched, REFRESH_MS)
    document.addEventListener('visibilitychange', refreshWatched)
  }
}

function stopRefreshing(): void {
  if (refreshTimer !== null && watched.size === 0) {
    clearInterval(refreshTimer)
    refreshTimer = null
    document.removeEventListener('visibilitychange', refreshWatched)
  }
}

/** Keeps the status of the URLs current while watched; the returned function stops it. */
export function watchPrStatuses(urls: readonly string[]): () => void {
  const fresh: string[] = []
  for (const url of urls) {
    const count = watched.get(url) ?? 0
    watched.set(url, count + 1)
    if (count === 0) {
      fresh.push(url)
    }
  }
  startRefreshing()
  ask(fresh)
  return () => {
    for (const url of urls) {
      const count = (watched.get(url) ?? 1) - 1
      if (count === 0) {
        watched.delete(url)
      } else {
        watched.set(url, count)
      }
    }
    stopRefreshing()
  }
}

/** Asks the server again for the URLs now, as when a list of them opens. */
export const reloadPrStatuses = (urls: readonly string[]): void => {
  ask(urls)
}

export const prStatus = (url: string): PrStatus => statuses.get(url) ?? LOADING

export function subscribePrStatuses(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const prStatusVersion = (): number => version
