import { z } from 'zod'
import { isRecord, lenientArray, orDefault, type ResponseSchema } from './lenient.js'
import { prUrl } from './pr-url.js'
import { TASK_STATUSES, type TaskStatus } from './tasks.js'

export const PR_SCOPES = ['mine', 'all'] as const
export type PrScope = (typeof PR_SCOPES)[number]

export const prByUrlQuery = z.object({ url: prUrl })

/** Most PRs one lookup resolves; above any agent's linked PRs. */
const MAX_PR_LOOKUP = 1000

/** PR URLs whose open pull requests one request returns, such as every PR an agent links. */
export const prLookupInput = z.object({ urls: z.array(prUrl).max(MAX_PR_LOOKUP) })

export const prListQuery = z.object({ scope: z.enum(PR_SCOPES).default('mine') })

export const prRefParams = z.object({
  owner: z.string().regex(/^[\w.-]+$/),
  repo: z.string().regex(/^[\w.-]+$/),
  number: z.coerce.number().int().positive(),
})

export type CiState = 'success' | 'failure' | 'pending' | 'neutral'
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required'
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown'

export interface PrCheck {
  name: string
  state: CiState
  detail: string
  url: string | null
}

export interface Preview {
  state: 'ready' | 'expired' | 'none'
  url: string | null
  commit: string | null
  stale: boolean
}

export type PreviewStatus = 'ready' | 'stale' | 'expired' | 'none'

/** The label whose `labeled` event makes the preview workflow deploy a PR. */
export const PREVIEW_LABEL = 'preview'

/** Result of requesting a preview; relabeled when the label was on the PR and was added again. */
export interface PreviewRequest {
  label: string
  relabeled: boolean
}

export interface LinkedTask {
  id: string
  title: string
  status: TaskStatus
}

export type MentionPlace = 'title' | 'body' | 'comment'

/** Why another PR relates to this one, seen from this PR. */
export type PrRelation =
  | { type: 'mentions'; place: MentionPlace }
  | { type: 'mentioned_by'; place: MentionPlace }
  | { type: 'same_task'; task_id: string; task_title: string }
  | { type: 'same_branch'; branch: string }

export interface RelatedPr {
  url: string
  /** The PR's key when it is open in a registered repo, else null. */
  key: string | null
  /** `repo#123` for open PRs of registered repos, `owner/repo#123` otherwise. */
  label: string
  title: string | null
  ci: CiState | null
  reasons: PrRelation[]
}

export interface PullRequest {
  key: string
  repo_id: string
  repo_slug: string
  number: number
  title: string
  url: string
  draft: boolean
  author: string | null
  head_ref: string
  base_ref: string
  head_oid: string
  updated_at: string
  review_decision: ReviewDecision | null
  mergeable: Mergeable
  labels: string[]
  ci: CiState | null
  checks: PrCheck[]
  /** Review threads not yet resolved, outdated ones included. */
  unresolved_threads: number
  preview: Preview
  preview_host: string | null
  tasks: LinkedTask[]
  related: RelatedPr[]
}

export interface RepoPrs {
  repo_id: string
  slug: string
  error: string | null
  /** True when any open PR of the repo, in any scope, has a preview comment. */
  previews: boolean
  prs: PullRequest[]
}

export interface PrList {
  /** Null when the GitHub CLI is not logged in; the mine scope is then empty. */
  viewer: string | null
  scope: PrScope
  repos: RepoPrs[]
  /** False while no mod fills in previews, so a preview cannot be requested. */
  previews_on: boolean
}

export const previewStatus = (preview: Preview): PreviewStatus =>
  preview.state === 'ready' && preview.stale ? 'stale' : preview.state

const repoName = (slug: string) => slug.split('/').at(-1) ?? slug

/** Short key for a PR, such as `seti-42`, that Seti's tools accept as a reference. */
export const prKey = (slug: string, number: number) => `${repoName(slug)}-${String(number)}`

/** Seti's own host; previews are its subdomains so their cookies count as same-site. */
export const SETI_HOST = 'seti.localhost'

/** Hostnames the Seti UI and API answer on. */
export const SETI_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', SETI_HOST])

const SUBDOMAIN_SUFFIX = `.${SETI_HOST}`

const LEGACY_SUBDOMAIN_SUFFIX = '.preview.localhost'

/** The Seti subdomain an incoming hostname names, such as `app-pr-7.seti.localhost`; else null. */
export function setiSubdomainOf(hostname: string): string | null {
  if (hostname.endsWith(SUBDOMAIN_SUFFIX)) {
    return hostname
  }
  if (hostname.endsWith(LEGACY_SUBDOMAIN_SUFFIX)) {
    return `${hostname.slice(0, -LEGACY_SUBDOMAIN_SUFFIX.length)}${SUBDOMAIN_SUFFIX}`
  }
  return null
}

const CI_STATES = ['success', 'failure', 'pending', 'neutral'] as const
const nullableText = (label: string) => orDefault(label, z.string().nullable(), null)
const ciField = (label: string) => orDefault<CiState | null>(label, z.enum(CI_STATES).nullable(), null)

const threadCount = orDefault('unresolved_threads', z.number().int().nonnegative(), 0)

/** The count as a hint, such as `3 unresolved review threads`; null when there are none. */
export function unresolvedThreadsText(count: number): string | null {
  if (count === 0) {
    return null
  }
  return `${String(count)} unresolved review ${count === 1 ? 'thread' : 'threads'}`
}

const NO_PREVIEW: Preview = { state: 'none', url: null, commit: null, stale: false }

const previewSchema = z.object({
  state: z.enum(['ready', 'expired', 'none']),
  url: z.string().nullable(),
  commit: z.string().nullable(),
  stale: z.boolean(),
})

const prCheckSchema = z.object({
  name: z.string(),
  state: orDefault<CiState>('check state', z.enum(CI_STATES), 'neutral'),
  detail: orDefault('check detail', z.string(), ''),
  url: nullableText('check url'),
})

const relatedPrSchema = z.object({
  url: z.string(),
  key: nullableText('related key'),
  label: z.string(),
  title: nullableText('related title'),
  ci: ciField('related ci'),
  reasons: lenientArray('related reason', z.custom<PrRelation>(isRecord)),
})

const pullRequestSchema = z.object({
  key: z.string(),
  repo_id: z.string(),
  repo_slug: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  draft: orDefault('draft', z.boolean(), false),
  author: nullableText('author'),
  head_ref: orDefault('head_ref', z.string(), ''),
  base_ref: orDefault('base_ref', z.string(), ''),
  head_oid: orDefault('head_oid', z.string(), ''),
  updated_at: z.string(),
  review_decision: orDefault<ReviewDecision | null>(
    'review_decision',
    z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
    null,
  ),
  mergeable: orDefault<Mergeable>('mergeable', z.enum(['mergeable', 'conflicting', 'unknown']), 'unknown'),
  labels: orDefault('labels', z.array(z.string()), []),
  ci: ciField('ci'),
  checks: lenientArray('check', prCheckSchema),
  unresolved_threads: threadCount,
  preview: orDefault('preview', previewSchema, NO_PREVIEW),
  preview_host: nullableText('preview_host'),
  tasks: lenientArray('linked agent', z.object({ id: z.string(), title: z.string(), status: z.enum(TASK_STATUSES) })),
  related: lenientArray('related pull request', relatedPrSchema),
}) satisfies ResponseSchema<PullRequest>

/** The open PRs a lookup found; URLs of closed or unknown PRs are left out. */
export const pullRequestsSchema = lenientArray('pull request', pullRequestSchema) satisfies ResponseSchema<
  PullRequest[]
>

const repoPrsSchema = z.object({
  repo_id: z.string(),
  slug: z.string(),
  error: nullableText('repo error'),
  previews: orDefault('repo previews', z.boolean(), false),
  prs: lenientArray('pull request', pullRequestSchema),
})

export const prListSchema = z.object({
  viewer: nullableText('viewer'),
  scope: z.enum(PR_SCOPES),
  repos: lenientArray('repo', repoPrsSchema),
  previews_on: orDefault('previews on', z.boolean(), true),
}) satisfies ResponseSchema<PrList>
