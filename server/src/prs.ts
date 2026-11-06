import type { LinkedTask, PrList, PrScope, PullRequest, Repo, RelatedPr, RepoPrs } from '@seti/shared'
import { repos } from './db.js'
import { addPreviewLabel, fetchOpenPrs, viewerLogin, type OpenPr } from './github.js'
import { HttpError } from './http.js'
import { prDecorators, previewsOn } from './pr-decorators.js'
import { relatePrs } from './pr-graph.js'
import { cache } from './redis.js'
import { tasksByPrUrl } from './store/prs.js'

const TTL_MS = 60_000
/** How long other processes, or this one after a restart, may serve a list they did not fetch. */
const SHARED_TTL_S = 60 * 60
const REFRESH_CLAIM_MS = 30_000

interface CacheEntry {
  at: number
  prs: OpenPr[] | null
  pending: Promise<OpenPr[]> | null
}

interface SharedPrs {
  at: number
  prs: OpenPr[]
}

const entries = new Map<string, CacheEntry>()
const fetchedListeners: ((prs: readonly OpenPr[]) => void)[] = []

/** Hears each repo's open PRs as this process fetches them from GitHub. */
export function onOpenPrsFetched(listener: (prs: readonly OpenPr[]) => void): void {
  fetchedListeners.push(listener)
}
/** The PR decorators in effect, so a list another set of mods decorated is fetched again. */
const decoratedBy = () =>
  prDecorators
    .list()
    .map((entry) => entry.key)
    .join(',')

const cacheKey = (repo: Repo) => `${repo.id}:${repo.slug}:${decoratedBy()}`
/** Versioned so lists cached before a field was added are fetched again. */
const sharedKey = (repo: Repo) => `gh:prs:v2:${cacheKey(repo)}`

function entryFor(repo: Repo): CacheEntry {
  const key = cacheKey(repo)
  const entry = entries.get(key) ?? { at: 0, prs: null, pending: null }
  entries.set(key, entry)
  return entry
}

function adopt(repo: Repo, shared: SharedPrs): OpenPr[] {
  const entry = entryFor(repo)
  entry.prs = shared.prs
  entry.at = shared.at
  return shared.prs
}

async function fetchShared(repo: Repo): Promise<SharedPrs> {
  const shared = { at: Date.now(), prs: await fetchOpenPrs(repo) }
  await cache.set(sharedKey(repo), shared, SHARED_TTL_S)
  for (const listener of fetchedListeners) {
    listener(shared.prs)
  }
  return shared
}

/** Asks GitHub unless another process fetched a fresh list meanwhile. */
async function revalidate(repo: Repo): Promise<OpenPr[]> {
  const entry = entryFor(repo)
  entry.pending ??= (async () => {
    const shared = await cache.get<SharedPrs>(sharedKey(repo))
    const fresh = shared !== undefined && Date.now() - shared.at < TTL_MS ? shared : await fetchShared(repo)
    return adopt(repo, fresh)
  })().finally(() => {
    entry.pending = null
  })
  return entry.pending
}

/** One process refreshes a stale list while every process keeps serving it. */
async function refreshInBackground(repo: Repo): Promise<void> {
  if (entryFor(repo).pending === null && !(await cache.claim(`${sharedKey(repo)}:refresh`, REFRESH_CLAIM_MS))) {
    return
  }
  // A failed background refresh keeps the stale list; the next call retries.
  await revalidate(repo).catch(() => undefined)
}

/** Fresh for a minute, then served stale while one shared gh call refreshes it. */
async function repoPrs(repo: Repo): Promise<OpenPr[]> {
  const entry = entryFor(repo)
  let prs = entry.prs
  if (prs === null) {
    const shared = await cache.get<SharedPrs>(sharedKey(repo))
    if (shared === undefined) {
      return revalidate(repo)
    }
    prs = adopt(repo, shared)
  }
  if (Date.now() - entry.at >= TTL_MS) {
    void refreshInBackground(repo)
  }
  return prs
}

interface RepoResult {
  repo: Repo
  prs: OpenPr[]
  error: string | null
}

async function loadAll(): Promise<RepoResult[]> {
  return Promise.all(
    (await repos.list()).map(async (repo) => {
      try {
        return { repo, prs: await repoPrs(repo), error: null }
      } catch (e) {
        return { repo, prs: [], error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
}

const sameLogin = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase()

const inScope = (pr: OpenPr, scope: PrScope, viewer: string | null) =>
  scope === 'all' || (viewer !== null && sameLogin(pr.author, viewer))

const viewerOrNull = async () => viewerLogin().catch(() => null)

interface Relations {
  tasks: Map<string, LinkedTask[]>
  related: Map<string, RelatedPr[]>
}

/** Relations across every cached PR; mentions were extracted once when each repo was fetched. */
async function relationsOf(prs: readonly OpenPr[]): Promise<Relations> {
  const tasks = await tasksByPrUrl()
  const bases = (await repos.list()).map((repo) => repo.base_branch)
  return { tasks, related: relatePrs(prs, tasks, bases) }
}

function withRelations({ refs: _refs, body: _body, ...pr }: OpenPr, relations: Relations): PullRequest {
  return { ...pr, tasks: relations.tasks.get(pr.url) ?? [], related: relations.related.get(pr.url) ?? [] }
}

export async function listPrs(scope: PrScope): Promise<PrList> {
  const [viewer, results] = await Promise.all([viewerOrNull(), loadAll()])
  const relations = await relationsOf(results.flatMap((r) => r.prs))
  const repoPrsList: RepoPrs[] = results.map(({ repo, error, prs }) => ({
    repo_id: repo.id,
    slug: repo.slug,
    error,
    previews: prs.some((pr) => pr.preview.state !== 'none'),
    prs: prs.filter((pr) => inScope(pr, scope, viewer)).map((pr) => withRelations(pr, relations)),
  }))
  return { viewer, scope, repos: repoPrsList, previews_on: previewsOn() }
}

/** An open PR of a registered repo by URL, with tasks and relations; null when closed or unknown. */
export async function findPr(url: string): Promise<PullRequest | null> {
  const prs = (await loadAll()).flatMap((r) => r.prs)
  const pr = prs.find((candidate) => candidate.url === url)
  return pr ? withRelations(pr, await relationsOf(prs)) : null
}

/** The open PRs of registered repos among the URLs, related once for the whole batch. */
export async function lookupPrs(urls: readonly string[]): Promise<PullRequest[]> {
  const prs = (await loadAll()).flatMap((r) => r.prs)
  const wanted = new Set(urls)
  const found = prs.filter((pr) => wanted.has(pr.url))
  if (found.length === 0) {
    return []
  }
  const relations = await relationsOf(prs)
  return found.map((pr) => withRelations(pr, relations))
}

/** Open PRs of every registered repo from the cache; only a repo never loaded waits for gh. */
export async function cachedOpenPrs(): Promise<OpenPr[]> {
  return (await loadAll()).flatMap((r) => r.prs)
}

/** Requests a fresh preview deploy; resolves true when the preview label had to be re-added. */
export async function redeployPreview(owner: string, name: string, number: number): Promise<boolean> {
  const slug = `${owner}/${name}`.toLowerCase()
  const repo = (await repos.list()).find((r) => r.slug.toLowerCase() === slug)
  if (!repo) {
    throw new HttpError(404, 'Repo is not registered in Seti')
  }
  if (!(await repoPrs(repo)).some((pr) => pr.number === number)) {
    throw new HttpError(404, 'Not an open pull request')
  }
  const relabeled = await addPreviewLabel(repo.slug, number)
  const entry = entries.get(cacheKey(repo))
  if (entry) {
    entry.at = 0
  }
  await cache.del(sharedKey(repo))
  return relabeled
}
