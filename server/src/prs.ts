import type { LinkedTask, PrList, PullRequest, RelatedPr } from '@seti/shared'
import { repos } from './db.js'
import { addPreviewLabel, fetchAuthoredPrs, fetchOpenPrsByUrl, viewerLogin, type OpenPr } from './github.js'
import { HttpError } from './http.js'
import { prDecorators, previewsOn } from './pr-decorators.js'
import { relatePrs } from './pr-graph.js'
import { cache } from './redis.js'
import { linkedPrUrls, tasksByPrUrl } from './store/prs.js'

const TTL_MS = 60_000
/** How long other processes, or this one after a restart, may serve a list they did not fetch. */
const SHARED_TTL_S = 60 * 60
const REFRESH_CLAIM_MS = 30_000

/** The open PRs as one fetch found them, newest first. */
interface OpenPrs {
  at: number
  prs: OpenPr[]
  /** Open PRs of the gh login that GitHub has beyond the ones its search returned. */
  more: number
  /** The linked PR URLs the fetch covered, so a PR linked since then asks GitHub again. */
  linked: string[]
}

interface CacheEntry {
  list: OpenPrs | null
  pending: Promise<OpenPrs> | null
}

const entries = new Map<string, CacheEntry>()
const fetchedListeners: ((prs: readonly OpenPr[]) => void)[] = []

/** Hears the open PRs each time this process fetches them from GitHub. */
export function onOpenPrsFetched(listener: (prs: readonly OpenPr[]) => void): void {
  fetchedListeners.push(listener)
}
/** The PR decorators in effect, so a list another set of mods decorated is fetched again. */
const decoratedBy = () =>
  prDecorators
    .list()
    .map((entry) => entry.key)
    .join(',')

/** Versioned so lists cached before a field was added are fetched again. */
const sharedKey = () => `gh:prs:v3:${decoratedBy()}`

function entryFor(): CacheEntry {
  const key = decoratedBy()
  const entry = entries.get(key) ?? { list: null, pending: null }
  entries.set(key, entry)
  return entry
}

const newestFirst = (a: OpenPr, b: OpenPr) => b.updated_at.localeCompare(a.updated_at)

/** One search for the login's open PRs, then a URL lookup for the linked PRs it left out. */
async function fetchFromGithub(): Promise<OpenPrs> {
  const [linked, authored] = await Promise.all([linkedPrUrls(), fetchAuthoredPrs()])
  const listed = new Set(authored.prs.map((pr) => pr.url))
  const others = await fetchOpenPrsByUrl(linked.filter((url) => !listed.has(url)))
  const byUrl = new Map([...authored.prs, ...others].map((pr) => [pr.url, pr]))
  return {
    at: Date.now(),
    prs: [...byUrl.values()].sort(newestFirst),
    more: Math.max(0, authored.total - authored.prs.length),
    linked,
  }
}

async function fetchShared(): Promise<OpenPrs> {
  const key = sharedKey()
  const list = await fetchFromGithub()
  await cache.set(key, list, SHARED_TTL_S)
  for (const listener of fetchedListeners) {
    listener(list.prs)
  }
  return list
}

/** Asks GitHub unless another process fetched a fresh list meanwhile; `force` always asks. */
async function revalidate(force = false): Promise<OpenPrs> {
  const entry = entryFor()
  entry.pending ??= (async () => {
    const shared = force ? undefined : await cache.get<OpenPrs>(sharedKey())
    const list = shared !== undefined && Date.now() - shared.at < TTL_MS ? shared : await fetchShared()
    entry.list = list
    return list
  })().finally(() => {
    entry.pending = null
  })
  return entry.pending
}

/** One process refreshes a stale list while every process keeps serving it. */
async function refreshInBackground(): Promise<void> {
  if (entryFor().pending === null && !(await cache.claim(`${sharedKey()}:refresh`, REFRESH_CLAIM_MS))) {
    return
  }
  // A failed background refresh keeps the stale list; the next call retries.
  await revalidate().catch(() => undefined)
}

/** Fresh for a minute, then served stale while one shared gh call refreshes it. */
async function openPrs(): Promise<OpenPrs> {
  const entry = entryFor()
  if (entry.list === null) {
    const shared = await cache.get<OpenPrs>(sharedKey())
    if (shared === undefined) {
      return revalidate()
    }
    entry.list = shared
  }
  if (Date.now() - entry.list.at >= TTL_MS) {
    void refreshInBackground()
  }
  return entry.list
}

/** The list, fetched again first when one of the URLs was linked to an agent after it was read. */
async function openPrsCovering(urls: readonly string[]): Promise<OpenPr[]> {
  const list = await openPrs()
  const known = new Set([...list.prs.map((pr) => pr.url), ...list.linked])
  const unseen = urls.filter((url) => !known.has(url))
  if (unseen.length === 0) {
    return list.prs
  }
  const linked = new Set(await linkedPrUrls())
  return unseen.some((url) => linked.has(url)) ? (await revalidate(true)).prs : list.prs
}

interface Loaded {
  prs: OpenPr[]
  more: number
  error: string | null
}

async function load(): Promise<Loaded> {
  try {
    const { prs, more } = await openPrs()
    return { prs, more, error: null }
  } catch (e) {
    return { prs: [], more: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

const viewerOrNull = async () => viewerLogin().catch(() => null)

interface Relations {
  tasks: Map<string, LinkedTask[]>
  related: Map<string, RelatedPr[]>
}

/** Relations across every cached PR; mentions were extracted once when the list was fetched. */
async function relationsOf(prs: readonly OpenPr[]): Promise<Relations> {
  const tasks = await tasksByPrUrl()
  const bases = (await repos.list()).map((repo) => repo.base_branch)
  return { tasks, related: relatePrs(prs, tasks, bases) }
}

function withRelations({ refs: _refs, body: _body, ...pr }: OpenPr, relations: Relations): PullRequest {
  return { ...pr, tasks: relations.tasks.get(pr.url) ?? [], related: relations.related.get(pr.url) ?? [] }
}

/** Every open PR the gh login wrote and every open PR linked to an agent, in any repo. */
export async function listPrs(): Promise<PrList> {
  const [viewer, { prs, more, error }] = await Promise.all([viewerOrNull(), load()])
  const relations = await relationsOf(prs)
  return { viewer, prs: prs.map((pr) => withRelations(pr, relations)), error, more, previews_on: previewsOn() }
}

/** The open PRs among the URLs, related once for the batch; closed or unknown ones are left out. */
export async function lookupPrs(urls: readonly string[]): Promise<PullRequest[]> {
  const prs = await openPrsCovering(urls).catch(() => [])
  const wanted = new Set(urls)
  const found = prs.filter((pr) => wanted.has(pr.url))
  if (found.length === 0) {
    return []
  }
  const relations = await relationsOf(prs)
  return found.map((pr) => withRelations(pr, relations))
}

/** An open PR by URL, listed or not, with tasks and relations; null when closed or unknown. */
export async function findPr(url: string): Promise<PullRequest | null> {
  const [listed] = await lookupPrs([url])
  if (listed) {
    return listed
  }
  const [pr] = await fetchOpenPrsByUrl([url]).catch(() => [])
  return pr ? withRelations(pr, await relationsOf([...(await load()).prs, pr])) : null
}

/** The listed open PRs from the cache; only a list never loaded waits for gh. */
export async function cachedOpenPrs(): Promise<OpenPr[]> {
  return (await load()).prs
}

/** Requests a fresh preview deploy; resolves true when the preview label had to be re-added. */
export async function redeployPreview(owner: string, name: string, number: number): Promise<boolean> {
  const slug = `${owner}/${name}`.toLowerCase()
  const pr = (await openPrs()).prs.find((open) => open.repo_slug.toLowerCase() === slug && open.number === number)
  if (!pr) {
    throw new HttpError(404, 'Not an open pull request Seti lists')
  }
  const relabeled = await addPreviewLabel(pr.repo_slug, number)
  const entry = entryFor()
  if (entry.list !== null) {
    entry.list = { ...entry.list, at: 0 }
  }
  await cache.del(sharedKey())
  return relabeled
}
