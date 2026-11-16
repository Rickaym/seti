import { z } from 'zod'
import { canPollGithub } from './github-cache.js'
import { fetchRowPage, fetchStatusPage, type ListedRow, type ListedStatus, type SearchPage } from './github-list.js'
import { cache } from './redis.js'
import { prListStore } from './store/pr-list.js'

const TTL_MS = 60_000
/** How long other processes, or this one after a restart, may serve a list they did not fetch. */
const SHARED_TTL_S = 60 * 60
const REFRESH_CLAIM_MS = 30_000
/** A failed first fetch is not retried for this long, so a gh with no login is not run per read. */
const FAILURE_TTL_MS = 10_000
/** Search pages of 100 one refresh reads at most; `more` counts the login's PRs past them. */
const MAX_PAGES = 2
/** Versioned so lists cached before a field was added are fetched again. */
const SHARED_KEY = 'gh:prs:v4'
const STORED_VERSION = 1

/** A row of the login's open PRs with its status, or without one while GitHub still computes it. */
export type ListedPr = ListedRow & Omit<ListedStatus, 'url'>

/** The login's open PRs as one fetch found them, newest first. */
export interface OpenList {
  at: number
  prs: ListedPr[]
  /** Open PRs of the gh login that GitHub has beyond the ones read. */
  more: number
}

const storedList = z.object({
  v: z.literal(STORED_VERSION),
  at: z.number(),
  more: z.number(),
  prs: z.array(z.custom<ListedPr>((row) => typeof row === 'object' && row !== null && 'url' in row)),
})

type OnRows = (list: OpenList) => void

let list: OpenList | null = null
let pending: Promise<OpenList> | null = null
/** The rows of the fetch in flight before their status, for a list no one has read yet. */
let firstRows: Promise<OpenList> | null = null
let failed: { at: number; error: unknown } | null = null
const fetchedListeners: (() => void)[] = []

/** Hears each time this process read the list from GitHub. */
export function onListFetched(listener: () => void): void {
  fetchedListeners.push(listener)
}

/** A search page by page while more follow, up to MAX_PAGES and while the budget allows. */
async function paged<T>(fetchPage: (after: string | null) => Promise<SearchPage<T>>) {
  const first = await fetchPage(null)
  const items = [...first.items]
  let next = first.next
  for (let page = 1; page < MAX_PAGES && next !== null && (await canPollGithub()); page += 1) {
    const following = await fetchPage(next)
    items.push(...following.items)
    next = following.next
  }
  return { items, total: first.total }
}

const NO_STATUS: Omit<ListedStatus, 'url'> = { review_decision: null, mergeable: 'unknown', ci: null }

function toList(rows: readonly ListedRow[], total: number, statuses: ReadonlyMap<string, Omit<ListedStatus, 'url'>>) {
  return {
    at: Date.now(),
    prs: rows.map((row) => ({ ...row, ...(statuses.get(row.url) ?? NO_STATUS) })),
    more: Math.max(0, total - rows.length),
  }
}

/** The rows and their status in two searches side by side; the rows are ready first. */
async function fetchList(onRows: OnRows): Promise<OpenList> {
  const statuses = paged(fetchStatusPage)
  // The rows report a failure first; this keeps a second one from going unhandled.
  statuses.catch(() => undefined)
  const rows = await paged(fetchRowPage)
  onRows(toList(rows.items, rows.total, new Map()))
  const known = new Map((await statuses).items.map(({ url, ...status }) => [url, status]))
  return toList(rows.items, rows.total, known)
}

async function fetchShared(onRows: OnRows): Promise<OpenList> {
  const fetched = await fetchList(onRows)
  await cache.set(SHARED_KEY, fetched, SHARED_TTL_S)
  // The durable copy is a convenience for the next start; a failed write costs nothing now.
  await prListStore.write(JSON.stringify({ v: STORED_VERSION, ...fetched })).catch(() => undefined)
  for (const listener of fetchedListeners) {
    listener()
  }
  return fetched
}

/** Asks GitHub unless another process fetched a fresh list meanwhile. */
async function revalidate(): Promise<OpenList> {
  if (pending !== null) {
    return pending
  }
  let onRows: OnRows = () => undefined
  firstRows = new Promise<OpenList>((resolve) => {
    onRows = resolve
  })
  pending = (async () => {
    const shared = await cache.get<OpenList>(SHARED_KEY)
    const fresh = shared !== undefined && Date.now() - shared.at < TTL_MS ? shared : await fetchShared(onRows)
    list = fresh
    failed = null
    return fresh
  })()
    .catch((error: unknown) => {
      failed = { at: Date.now(), error }
      throw error
    })
    .finally(() => {
      pending = null
      firstRows = null
    })
  return pending
}

/** One process refreshes a stale list while every process keeps serving it. */
async function refreshInBackground(): Promise<void> {
  if (pending === null && !(await cache.claim(`${SHARED_KEY}:refresh`, REFRESH_CLAIM_MS))) {
    return
  }
  // A failed background refresh keeps the stale list; the next call retries.
  await revalidate().catch(() => undefined)
}

/** The list the database kept from before a restart, however old; undefined when it has none. */
async function durableList(): Promise<OpenList | undefined> {
  const stored = await prListStore.read().catch(() => undefined)
  if (stored === undefined) {
    return undefined
  }
  try {
    const { at, prs, more } = storedList.parse(JSON.parse(stored.payload))
    return { at, prs, more }
  } catch {
    return undefined
  }
}

/**
 * The list: fresh for a minute, then served stale while one gh call refreshes it. A process that
 * has none takes the shared copy, then the stored one; with neither, `rowsFirst` skips the wait
 * for the status of the rows.
 */
export async function openList(rowsFirst = false): Promise<OpenList> {
  if (list === null) {
    const kept = (await cache.get<OpenList>(SHARED_KEY)) ?? (await durableList())
    if (kept === undefined) {
      if (failed !== null && Date.now() - failed.at < FAILURE_TTL_MS) {
        throw failed.error
      }
      const fetching = revalidate()
      return rowsFirst && firstRows !== null ? Promise.race([firstRows, fetching]) : fetching
    }
    list ??= kept
  }
  if (Date.now() - list.at >= TTL_MS) {
    void refreshInBackground()
  }
  return list
}

/** Whether a newer list is on its way: the one served is stale or a fetch is in flight. */
export const listRefreshing = (): boolean => pending !== null || (list !== null && Date.now() - list.at >= TTL_MS)
