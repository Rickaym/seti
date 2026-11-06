import path from 'node:path'

/** A pull request on the demo's fake GitHub; Seti reads it through the in-process `gh`. */
export interface DemoPr {
  slug: string
  number: number
  title: string
  body: string
  branch: string
  updatedAt: string
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks: readonly [name: string, conclusion: 'SUCCESS' | 'FAILURE' | null][]
  unresolvedThreads: number
  labels: readonly string[]
}

/** Who the fake GitHub says is signed in; the demo's agents open their PRs as this account. */
const DEMO_LOGIN = 'acme-dev'

const prs = new Map<string, DemoPr>()
const repoDirs = new Map<string, string>()

const prUrl = (pr: Pick<DemoPr, 'slug' | 'number'>) => `https://github.com/${pr.slug}/pull/${String(pr.number)}`

export function addDemoPr(pr: DemoPr): string {
  const url = prUrl(pr)
  prs.set(url, pr)
  return url
}

/** Remembers where each demo repo lives, so an agent's PR lands on the repo it works in. */
export function registerDemoRepo(slug: string, dir: string): void {
  repoDirs.set(path.resolve(dir), slug)
}

export function repoForDir(dir: string): string {
  const resolved = path.resolve(dir)
  for (const [root, slug] of repoDirs) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return slug
    }
  }
  return repoDirs.values().next().value ?? 'acme/storefront'
}

/** Opens a PR with green checks waiting for review, numbered after the repo's last one. */
export function openDemoPr(slug: string, title: string, branch: string): string {
  const numbers = [...prs.values()].filter((pr) => pr.slug === slug).map((pr) => pr.number)
  const number = Math.max(480, ...numbers) + 1
  return addDemoPr({
    slug,
    number,
    title,
    body: `${title}\n\nOpened by a scripted agent in the Seti demo.`,
    branch,
    updatedAt: new Date().toISOString(),
    review: 'REVIEW_REQUIRED',
    checks: [
      ['lint', 'SUCCESS'],
      ['typecheck', 'SUCCESS'],
      ['unit', 'SUCCESS'],
      ['e2e', null],
    ],
    unresolvedThreads: 0,
    labels: [],
  })
}

const rollupState = (pr: DemoPr) => {
  if (pr.checks.some(([, conclusion]) => conclusion === 'FAILURE')) {
    return 'FAILURE'
  }
  return pr.checks.every(([, conclusion]) => conclusion === 'SUCCESS') ? 'SUCCESS' : 'PENDING'
}

/** One PR with every field any of Seti's PR queries selects. */
function prNode(pr: DemoPr) {
  const head = `${pr.slug}#${String(pr.number)}`.replace(/\W/g, '').padEnd(40, '0').slice(0, 40)
  const contexts = pr.checks.map(([name, conclusion]) => ({
    __typename: 'CheckRun',
    name,
    status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion,
    detailsUrl: null,
    checkSuite: null,
  }))
  return {
    url: prUrl(pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    isDraft: false,
    state: 'OPEN',
    closedAt: null,
    headRefName: pr.branch,
    baseRefName: 'main',
    headRefOid: head,
    headRepository: { nameWithOwner: pr.slug },
    repository: { nameWithOwner: pr.slug },
    updatedAt: pr.updatedAt,
    reviewDecision: pr.review,
    mergeable: 'MERGEABLE',
    author: { __typename: 'User', login: DEMO_LOGIN },
    labels: { nodes: pr.labels.map((name) => ({ name })) },
    commits: {
      nodes: [{ commit: { oid: head, statusCheckRollup: { state: rollupState(pr), contexts: { nodes: contexts } } } }],
    },
    comments: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: Array.from({ length: pr.unresolvedThreads }, () => ({ isResolved: false })) },
  }
}

/** The `-f name=value` fields of a gh call. */
function fields(args: readonly string[]): Map<string, string> {
  const found = new Map<string, string>()
  args.forEach((arg, index) => {
    const value = args[index + 1]
    if (arg === '-f' && value !== undefined) {
      const at = value.indexOf('=')
      found.set(value.slice(0, at), value.slice(at + 1))
    }
  })
  return found
}

function graphql(args: readonly string[]): string {
  const given = fields(args)
  const owner = given.get('owner')
  const name = given.get('name')
  if (owner !== undefined && name !== undefined) {
    const slug = `${owner}/${name}`
    const nodes = [...prs.values()].filter((pr) => pr.slug === slug).map(prNode)
    return JSON.stringify({ data: { repository: { pullRequests: { nodes } } } })
  }
  const lookups = [...given].filter(([key]) => /^u\d+$/.test(key))
  const data = Object.fromEntries(
    lookups.map(([key, url]) => {
      const pr = prs.get(url)
      return [`p${key.slice(1)}`, pr === undefined ? null : prNode(pr)]
    }),
  )
  return JSON.stringify({ data })
}

/** Answers the read-only `gh api` calls Seti makes; every other gh call is refused. */
export function fakeGh(args: readonly string[]): string | null {
  const [command, endpoint] = args
  if (command !== 'api') {
    return null
  }
  if (endpoint === 'user') {
    return `${DEMO_LOGIN}\n`
  }
  if (endpoint === 'rate_limit') {
    return JSON.stringify({ limit: 5000, used: 0, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 })
  }
  return endpoint === 'graphql' ? graphql(args) : null
}
