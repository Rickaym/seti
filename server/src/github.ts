import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  PREVIEW_LABEL,
  prKey,
  type CiState,
  type LinkedPrState,
  type Mergeable,
  type PrCheck,
  type PullRequest,
  type Repo,
  type ReviewDecision,
} from '@seti/shared'
import { z } from 'zod'
import { readRollup, ROLLUP_FIELDS, statusCheckRollup } from './github-checks.js'
import { reviewThreads, THREAD_FIELDS, unresolvedThreads } from './github-threads.js'
import { decoratePr } from './pr-decorators.js'
import { extractPrRefs, type PrRef, type PrText } from './pr-refs.js'
import { cache } from './redis.js'

const exec = promisify(execFile)

const PR_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title body url isDraft headRefName baseRefName headRefOid updatedAt reviewDecision mergeable
        author { login }
        labels(first: 20) { nodes { name } }
        commits(last: 1) { nodes { commit { ${ROLLUP_FIELDS} } } }
        comments(last: 30) { nodes { author { login } body updatedAt } }
        ${THREAD_FIELDS}
      }
    }
  }
}`

const login = z.object({ login: z.string() }).nullable()

const ghPullRequest = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  updatedAt: z.string(),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  mergeable: z.string(),
  author: login,
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup,
        }),
      }),
    ),
  }),
  comments: z.object({
    nodes: z.array(z.object({ author: login, body: z.string(), updatedAt: z.string() })),
  }),
  reviewThreads,
})
type GhPullRequest = z.infer<typeof ghPullRequest>

const ghPrResponse = z.object({
  data: z.object({
    repository: z.object({ pullRequests: z.object({ nodes: z.array(ghPullRequest) }) }).nullable(),
  }),
})

/** A PR as GitHub reports it, with its text and references; tasks and relations come later. */
export type OpenPr = Omit<PullRequest, 'tasks' | 'related'> & { refs: PrRef[]; body?: string }

function mergeable(value: string): Mergeable {
  return value === 'MERGEABLE' || value === 'CONFLICTING' ? (value.toLowerCase() as Mergeable) : 'unknown'
}

function toOpenPr(repo: Pick<Repo, 'id' | 'slug'>, pr: GhPullRequest): OpenPr {
  const rollup = pr.commits.nodes.at(-1)?.commit.statusCheckRollup ?? null
  const comments = pr.comments.nodes.map((c) => ({
    author: c.author?.login ?? null,
    body: c.body,
    updatedAt: c.updatedAt,
  }))
  const texts: PrText[] = [
    { place: 'title', text: pr.title },
    { place: 'body', text: pr.body },
    ...comments.map((c) => ({ place: 'comment' as const, text: c.body })),
  ]
  return {
    key: prKey(repo.slug, pr.number),
    repo_id: repo.id,
    repo_slug: repo.slug,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    draft: pr.isDraft,
    author: pr.author?.login ?? null,
    head_ref: pr.headRefName,
    base_ref: pr.baseRefName,
    head_oid: pr.headRefOid,
    updated_at: pr.updatedAt,
    review_decision: pr.reviewDecision === null ? null : (pr.reviewDecision.toLowerCase() as ReviewDecision),
    mergeable: mergeable(pr.mergeable),
    labels: pr.labels.nodes.map((l) => l.name),
    ...readRollup(rollup),
    unresolved_threads: unresolvedThreads(pr.reviewThreads),
    ...decoratePr({ slug: repo.slug, number: pr.number, headOid: pr.headRefOid }, comments),
    refs: extractPrRefs({ slug: repo.slug, number: pr.number }, texts),
    body: pr.body,
  }
}

export function parsePrResponse(repo: Pick<Repo, 'id' | 'slug'>, stdout: string): OpenPr[] {
  const repository = ghPrResponse.parse(JSON.parse(stdout)).data.repository
  if (repository === null) {
    throw new Error(`GitHub has no repository ${repo.slug}`)
  }
  return repository.pullRequests.nodes.map((pr) => toOpenPr(repo, pr))
}

export function prQueryArgs(slug: string): string[] {
  const [owner = '', name = ''] = slug.split('/')
  return ['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`]
}

const labelsPath = (slug: string, number: number) => `repos/${slug}/issues/${String(number)}/labels`

export const labelListArgs = (slug: string, number: number) => [
  'api',
  `${labelsPath(slug, number)}?per_page=100`,
  '--jq',
  '.[].name',
]

export const labelAddArgs = (slug: string, number: number, label: string) => [
  'api',
  '--method',
  'POST',
  labelsPath(slug, number),
  '-f',
  `labels[]=${label}`,
]

export const labelRemoveArgs = (slug: string, number: number, label: string) => [
  'api',
  '--method',
  'DELETE',
  `${labelsPath(slug, number)}/${encodeURIComponent(label)}`,
]

function stderrOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'stderr' in e && typeof e.stderr === 'string') {
    return e.stderr.trim()
  }
  return ''
}

export async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (e) {
    const stderr = stderrOf(e)
    throw new Error(stderr === '' ? `gh ${args[0] ?? ''} failed` : stderr, { cause: e })
  }
}

export const fetchOpenPrs = async (repo: Pick<Repo, 'id' | 'slug'>): Promise<OpenPr[]> =>
  parsePrResponse(repo, await gh(prQueryArgs(repo.slug)))

let viewer: Promise<string> | null = null

export async function viewerLogin(): Promise<string> {
  viewer ??= cache.remember('gh:viewer', 60 * 60, async () => (await gh(['api', 'user', '--jq', '.login'])).trim())
  try {
    return await viewer
  } catch (e) {
    viewer = null
    throw e
  }
}

/** Adds the preview label, re-adding a present one so a labeled event fires; true if re-added. */
export async function addPreviewLabel(slug: string, number: number): Promise<boolean> {
  const names = (await gh(labelListArgs(slug, number))).split('\n').map((name) => name.trim().toLowerCase())
  const present = names.includes(PREVIEW_LABEL)
  if (present) {
    await gh(labelRemoveArgs(slug, number, PREVIEW_LABEL))
  }
  await gh(labelAddArgs(slug, number, PREVIEW_LABEL))
  return present
}

const WATCH_FIELDS = `url number state mergeable closedAt
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { oid ${ROLLUP_FIELDS} } } }
  reviews(last: 20) { nodes {
    id state body url submittedAt author { __typename login }
    comments(first: 30) { nodes { path line originalLine body url } }
  } }
  comments(last: 30) { nodes { id body url createdAt author { __typename login } } }`

const RESOURCE_BATCH = 20

const actor = z.object({ __typename: z.string(), login: z.string() }).nullable()

const ghWatchedPr = z.object({
  url: z.string(),
  number: z.number().int(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  mergeable: z.string(),
  closedAt: z.string().nullable(),
  repository: z.object({ nameWithOwner: z.string() }),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          oid: z.string(),
          statusCheckRollup,
        }),
      }),
    ),
  }),
  reviews: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        state: z.string(),
        body: z.string(),
        url: z.string(),
        submittedAt: z.string().nullable(),
        author: actor,
        comments: z.object({
          nodes: z.array(
            z.object({
              path: z.string(),
              line: z.number().int().nullable(),
              originalLine: z.number().int().nullable(),
              body: z.string(),
              url: z.string(),
            }),
          ),
        }),
      }),
    ),
  }),
  comments: z.object({
    nodes: z.array(
      z.object({ id: z.string(), body: z.string(), url: z.string(), createdAt: z.string(), author: actor }),
    ),
  }),
})

const ghResourceResponse = z.object({ data: z.record(z.string(), z.record(z.string(), z.unknown()).nullable()) })

/** Who wrote a review or comment; bots are GitHub Apps and Actions. */
export interface PrAuthor {
  login: string
  bot: boolean
}

export interface WatchedReview {
  id: string
  state: string
  body: string
  url: string
  /** Null while the review is pending, which only its author sees. */
  submitted_at: string | null
  author: PrAuthor | null
  comments: { path: string; line: number | null; body: string; url: string }[]
}

export interface WatchedComment {
  id: string
  body: string
  url: string
  created_at: string
  author: PrAuthor | null
}

/** The parts of a PR that Seti turns into task updates. */
export interface WatchedPr {
  url: string
  subject: string
  state: LinkedPrState
  /** When the PR merged or closed; null while it is open. */
  closed_at: string | null
  conflicting: boolean
  head_oid: string | null
  ci: CiState | null
  checks: PrCheck[]
  reviews: WatchedReview[]
  comments: WatchedComment[]
}

const WATCH_STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const

const toAuthor = (author: z.infer<typeof actor>): PrAuthor | null =>
  author === null ? null : { login: author.login, bot: author.__typename === 'Bot' }

function toWatchedPr(pr: z.infer<typeof ghWatchedPr>): WatchedPr {
  const commit = pr.commits.nodes.at(-1)?.commit ?? null
  const rollup = commit?.statusCheckRollup ?? null
  return {
    url: pr.url,
    subject: `${pr.repository.nameWithOwner}#${String(pr.number)}`,
    state: WATCH_STATES[pr.state],
    closed_at: pr.closedAt,
    conflicting: pr.mergeable === 'CONFLICTING',
    head_oid: commit?.oid ?? null,
    ...readRollup(rollup),
    reviews: pr.reviews.nodes.map((review) => ({
      id: review.id,
      state: review.state,
      body: review.body,
      url: review.url,
      submitted_at: review.submittedAt,
      author: toAuthor(review.author),
      comments: review.comments.nodes.map((comment) => ({
        path: comment.path,
        line: comment.line ?? comment.originalLine,
        body: comment.body,
        url: comment.url,
      })),
    })),
    comments: pr.comments.nodes.map(({ createdAt, ...comment }) => ({
      ...comment,
      created_at: createdAt,
      author: toAuthor(comment.author),
    })),
  }
}

/** One aliased `resource(url:)` lookup per URL, with the URLs passed as GraphQL variables. */
function resourceQueryArgs(urls: readonly string[], prFields: string): string[] {
  const params = urls.map((_, index) => `$u${String(index)}: URI!`).join(', ')
  const fields = urls
    .map((_, index) => `p${String(index)}: resource(url: $u${String(index)}) { ... on PullRequest { ${prFields} } }`)
    .join('\n')
  const variables = urls.flatMap((url, index) => ['-f', `u${String(index)}=${url}`])
  return ['api', 'graphql', '-f', `query=query(${params}) {\n${fields}\n}`, ...variables]
}

export const watchQueryArgs = (urls: readonly string[]) => resourceQueryArgs(urls, WATCH_FIELDS)

/** Parsed nodes by alias order; null where the URL is not a PR gh can read. */
function parseResources<T>(
  urls: readonly string[],
  stdout: string,
  parse: (node: unknown) => T,
): Map<string, T | null> {
  const data = ghResourceResponse.parse(JSON.parse(stdout)).data
  return new Map(
    urls.map((url, index) => {
      const node = data[`p${String(index)}`] ?? null
      const isPr = node !== null && Object.keys(node).length > 0
      return [url, isPr ? parse(node) : null]
    }),
  )
}

const parseWatched = (node: unknown) => toWatchedPr(ghWatchedPr.parse(node))

export const parseWatchResponse = (urls: readonly string[], stdout: string) =>
  parseResources(urls, stdout, parseWatched)

/** Looks the URLs up in batches; a failed batch rejects the whole call. */
async function fetchResources<T>(
  urls: readonly string[],
  prFields: string,
  parse: (node: unknown) => T,
): Promise<Map<string, T | null>> {
  const found = new Map<string, T | null>()
  for (let start = 0; start < urls.length; start += RESOURCE_BATCH) {
    const batch = urls.slice(start, start + RESOURCE_BATCH)
    for (const [url, value] of parseResources(batch, await gh(resourceQueryArgs(batch, prFields)), parse)) {
      found.set(url, value)
    }
  }
  return found
}

export const fetchWatchedPrs = async (urls: readonly string[]) => fetchResources(urls, WATCH_FIELDS, parseWatched)

/** A PR's head branch and the repo it lives in, under the URL GitHub gives the PR. */
export interface PrHead {
  url: string
  head_ref: string
  /** owner/name of the head repo; null once that repo is deleted. */
  head_repo: string | null
}

const HEAD_FIELDS = 'url headRefName headRepository { nameWithOwner }'

const ghPrHead = z.object({
  url: z.string(),
  headRefName: z.string(),
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
})

function parseHead(node: unknown): PrHead {
  const pr = ghPrHead.parse(node)
  return { url: pr.url, head_ref: pr.headRefName, head_repo: pr.headRepository?.nameWithOwner ?? null }
}

/** Head branch and repo of each PR; null where the URL is not a PR gh can read. */
export const fetchPrHeads = async (urls: readonly string[]) => fetchResources(urls, HEAD_FIELDS, parseHead)
