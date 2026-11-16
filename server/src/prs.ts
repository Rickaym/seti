import type { LinkedTask, PrList, PrLookup, PrRow, PullRequest, RelatedPr } from '@seti/shared'
import { repos } from './db.js'
import { canPollGithub } from './github-cache.js'
import { addPreviewLabel, viewerLogin, type OpenPr } from './github.js'
import { HttpError } from './http.js'
import { previewsOn } from './pr-decorators.js'
import { knownDetail, onDetailsFetched, prDetails, refreshDetails, staleDetail } from './pr-details.js'
import { relatePrs } from './pr-graph.js'
import { listRefreshing, onListFetched, openList, type ListedPr } from './pr-list.js'
import { linkedPrUrls, tasksByPrUrl } from './store/prs.js'

/** A status lookup waits this long for detail GitHub has not sent yet, then reports it pending. */
const LOOKUP_WAIT_MS = 2500
/** One PR asked for by URL, such as by a tool, waits longer before it reads as unknown. */
const FIND_WAIT_MS = 20_000
const WARM_DELAY_MS = 5000

/** Hears the PRs whose detail this process read, and an empty batch when it read the list. */
export function onOpenPrsFetched(listener: (prs: readonly OpenPr[]) => void): void {
  onDetailsFetched(listener)
  onListFetched(() => {
    listener([])
  })
}

/** What a listed row lacks until its detail is read. */
const NO_DETAIL = {
  head_oid: '',
  labels: [],
  checks: [],
  unresolved_threads: 0,
  preview: { state: 'none', url: null, commit: null, stale: false },
  preview_host: null,
  refs: [],
} satisfies Partial<OpenPr>

const withoutDetail = (row: ListedPr): OpenPr => ({ ...row, ...NO_DETAIL })

const newestFirst = (a: OpenPr, b: OpenPr) => b.updated_at.localeCompare(a.updated_at)

interface Loaded {
  /** Listed rows with the detail read so far, and the open linked PRs the list does not hold. */
  prs: OpenPr[]
  linked: string[]
  more: number
  error: string | null
}

/** Reads the detail of linked PRs ahead of the views that show it, while the budget allows. */
async function prefetchLinked(linked: readonly string[]): Promise<void> {
  if (linked.length > 0 && (await canPollGithub())) {
    await refreshDetails(linked)
  }
}

async function load(rowsFirst: boolean): Promise<Loaded> {
  const linked = await linkedPrUrls()
  void prefetchLinked(linked).catch(() => undefined)
  const others = (listed: ReadonlySet<string>) =>
    linked.filter((url) => !listed.has(url)).flatMap((url) => knownDetail(url) ?? [])
  try {
    const list = await openList(rowsFirst)
    const rows = list.prs.map((row) => knownDetail(row.url) ?? withoutDetail(row))
    const listed = new Set(rows.map((pr) => pr.url))
    return { prs: [...rows, ...others(listed)].sort(newestFirst), linked, more: list.more, error: null }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return { prs: others(new Set()).sort(newestFirst), linked, more: 0, error }
  }
}

const viewerOrNull = async () => viewerLogin().catch(() => null)

interface Relations {
  tasks: Map<string, LinkedTask[]>
  related: Map<string, RelatedPr[]>
}

/** Relations across the PRs; mentions come from the detail of those that have one. */
async function relationsOf(prs: readonly OpenPr[]): Promise<Relations> {
  const tasks = await tasksByPrUrl()
  const bases = (await repos.list()).map((repo) => repo.base_branch)
  return { tasks, related: relatePrs(prs, tasks, bases) }
}

function withRelations({ refs: _refs, body: _body, ...pr }: OpenPr, relations: Relations): PullRequest {
  return { ...pr, tasks: relations.tasks.get(pr.url) ?? [], related: relations.related.get(pr.url) ?? [] }
}

const toRow = (pr: OpenPr, tasks: ReadonlyMap<string, LinkedTask[]>): PrRow => ({
  key: pr.key,
  repo_slug: pr.repo_slug,
  number: pr.number,
  title: pr.title,
  url: pr.url,
  draft: pr.draft,
  author: pr.author,
  head_ref: pr.head_ref,
  base_ref: pr.base_ref,
  updated_at: pr.updated_at,
  review_decision: pr.review_decision,
  mergeable: pr.mergeable,
  ci: pr.ci,
  tasks: tasks.get(pr.url) ?? [],
})

/** Every open PR the gh login wrote and every open PR linked to an agent, as slim rows. */
export async function listPrs(): Promise<PrList> {
  const [viewer, { prs, more, error }, tasks] = await Promise.all([viewerOrNull(), load(true), tasksByPrUrl()])
  return {
    viewer,
    prs: prs.map((pr) => toRow(pr, tasks)),
    error,
    more,
    refreshing: listRefreshing(),
    previews_on: previewsOn(),
  }
}

/**
 * The detail of the listed or linked open PRs among the URLs, related once for the batch. A URL
 * GitHub has not answered within the wait is pending; one in neither list is no open PR.
 */
export async function lookupPrs(urls: readonly string[], waitMs = LOOKUP_WAIT_MS): Promise<PrLookup> {
  const { prs, linked } = await load(true)
  const allowed = new Set([...prs.map((pr) => pr.url), ...linked])
  const { details, pending } = await prDetails(
    urls.filter((url) => allowed.has(url)),
    waitMs,
  )
  const found = [...details.values()].filter((pr) => pr !== null)
  if (found.length === 0) {
    return { prs: [], pending }
  }
  const detailed = new Map(found.map((pr) => [pr.url, pr]))
  const relations = await relationsOf([...prs.filter((pr) => !detailed.has(pr.url)), ...found])
  return { prs: found.map((pr) => withRelations(pr, relations)), pending }
}

/** An open PR by URL, listed or not, with its detail and relations; null when closed or unknown. */
export async function findPr(url: string): Promise<PullRequest | null> {
  const pr = (await prDetails([url], FIND_WAIT_MS)).details.get(url) ?? null
  if (pr === null) {
    return null
  }
  const others = (await load(true)).prs.filter((listed) => listed.url !== url)
  return withRelations(pr, await relationsOf([...others, pr]))
}

/** The open PRs Seti knows, with the detail read so far; only a list never loaded waits for gh. */
export async function cachedOpenPrs(): Promise<OpenPr[]> {
  return (await load(true)).prs
}

/** Requests a fresh preview deploy; resolves true when the preview label had to be re-added. */
export async function redeployPreview(owner: string, name: string, number: number): Promise<boolean> {
  const slug = `${owner}/${name}`.toLowerCase()
  const pr = (await load(false)).prs.find((open) => open.repo_slug.toLowerCase() === slug && open.number === number)
  if (!pr) {
    throw new HttpError(404, 'Not an open pull request Seti lists')
  }
  const relabeled = await addPreviewLabel(pr.repo_slug, number)
  await staleDetail(pr.url)
  return relabeled
}

/** Marks the detail of a PR the poller saw change as stale, so views read it again. */
export const prChanged = async (url: string): Promise<void> => staleDetail(url)

/** Reads the list once shortly after start, so the first PR view does not wait for GitHub. */
export function warmOpenPrs(): void {
  const warm = async () => {
    if (await canPollGithub()) {
      await load(false)
    }
  }
  setTimeout(() => void warm().catch(() => undefined), WARM_DELAY_MS).unref()
}
