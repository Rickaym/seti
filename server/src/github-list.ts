import { prKey, type CiState, type Mergeable, type PrRow, type ReviewDecision } from '@seti/shared'
import { z } from 'zod'
import { readRollup } from './github-checks.js'
import { gh, toMergeable } from './github.js'

/** The open PRs the gh login wrote, in any repo, newest first. */
const AUTHORED_SEARCH = 'is:pr is:open author:@me sort:updated-desc'

/** PRs one search page holds, the most GitHub allows. */
export const LIST_PAGE = 100

/** What a row needs to render, sort and search; GitHub answers these fields quickly. */
const ROW_FIELDS = `number title url state isDraft headRefName baseRefName updatedAt
  repository { nameWithOwner }
  author { login }`

/** What GitHub computes per PR and answers slowly, read beside the rows and merged in by URL. */
const STATUS_FIELDS = `url state reviewDecision mergeable
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`

const searchQuery = (fields: string) => `query($q: String!, $after: String) {
  search(type: ISSUE, query: $q, first: ${String(LIST_PAGE)}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${fields} } }
  }
}`

const searchArgs = (fields: string, after: string | null): string[] => [
  'api',
  'graphql',
  '-f',
  `query=${searchQuery(fields)}`,
  '-f',
  `q=${AUTHORED_SEARCH}`,
  ...(after === null ? [] : ['-f', `after=${after}`]),
]

export const rowQueryArgs = (after: string | null = null) => searchArgs(ROW_FIELDS, after)
export const statusQueryArgs = (after: string | null = null) => searchArgs(STATUS_FIELDS, after)

const state = z.enum(['OPEN', 'CLOSED', 'MERGED'])

const ghRow = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state,
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  updatedAt: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
  author: z.object({ login: z.string() }).nullable(),
})

const ghStatus = z.object({
  url: z.string(),
  state,
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  mergeable: z.string(),
  commits: z.object({
    nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })),
  }),
})

const ghSearchResponse = z.object({
  data: z.object({
    search: z.object({
      issueCount: z.number().int(),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(z.unknown()),
    }),
  }),
})

/** A row as the list search reports it, before its status and linked agents are known. */
export type ListedRow = Omit<PrRow, 'review_decision' | 'mergeable' | 'ci' | 'tasks'>

/** The part of a row GitHub answers slowly. */
export interface ListedStatus {
  url: string
  review_decision: ReviewDecision | null
  mergeable: Mergeable
  ci: CiState | null
}

/** One page of a search over the login's open PRs, with the cursor of the next page. */
export interface SearchPage<T> {
  items: T[]
  /** How many open PRs of the login GitHub has in all. */
  total: number
  next: string | null
}

const isNode = (node: unknown) => typeof node === 'object' && node !== null && Object.keys(node).length > 0

function parsePage<N extends { state: string }, T>(stdout: string, schema: z.ZodType<N>, to: (node: N) => T) {
  const { issueCount, pageInfo, nodes } = ghSearchResponse.parse(JSON.parse(stdout)).data.search
  const open = nodes.filter(isNode).map((node) => schema.parse(node))
  return {
    items: open.filter((node) => node.state === 'OPEN').map(to),
    total: issueCount,
    next: pageInfo.hasNextPage ? pageInfo.endCursor : null,
  }
}

function toRow(pr: z.infer<typeof ghRow>): ListedRow {
  const slug = pr.repository.nameWithOwner
  return {
    key: prKey(slug, pr.number),
    repo_slug: slug,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    draft: pr.isDraft,
    author: pr.author?.login ?? null,
    head_ref: pr.headRefName,
    base_ref: pr.baseRefName,
    updated_at: pr.updatedAt,
  }
}

function toStatus(pr: z.infer<typeof ghStatus>): ListedStatus {
  const rollup = pr.commits.nodes.at(-1)?.commit.statusCheckRollup ?? null
  return {
    url: pr.url,
    review_decision: pr.reviewDecision === null ? null : (pr.reviewDecision.toLowerCase() as ReviewDecision),
    mergeable: toMergeable(pr.mergeable),
    ci: rollup === null ? null : readRollup({ state: rollup.state, contexts: { nodes: [] } }).ci,
  }
}

export const parseRowPage = (stdout: string): SearchPage<ListedRow> => parsePage(stdout, ghRow, toRow)
export const parseStatusPage = (stdout: string): SearchPage<ListedStatus> => parsePage(stdout, ghStatus, toStatus)

/** One page of the login's open PRs as rows; it runs as the host gh login. */
export const fetchRowPage = async (after: string | null) => parseRowPage(await gh(rowQueryArgs(after)))

/** One page of the status of the login's open PRs, in the order of the rows. */
export const fetchStatusPage = async (after: string | null) => parseStatusPage(await gh(statusQueryArgs(after)))
