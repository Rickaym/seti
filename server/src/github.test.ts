import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addPreviewLabel,
  labelAddArgs,
  labelListArgs,
  labelRemoveArgs,
  openPrQueryArgs,
  parseOpenPrResponse,
  parseSearchResponse,
  parseWatchResponse,
  searchQueryArgs,
  watchQueryArgs,
} from './github.js'
import { prDecorators } from './pr-decorators.js'

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void

const gh = vi.hoisted(() => ({ calls: [] as string[][], labels: '', failOn: '' }))

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    gh.calls.push(args)
    if (gh.failOn !== '' && args.includes(gh.failOn)) {
      callback(Object.assign(new Error('gh failed'), { stderr: 'HTTP 403: Resource not accessible\n' }))
      return
    }
    callback(null, { stdout: args.includes('--jq') ? gh.labels : '', stderr: '' })
  },
}))

const SLUG = 'globex/dashboard'

const READY = [
  '## Preview Environment Ready',
  '',
  '**Preview URL:** https://pr-2231-staging.example.com',
  '',
  '| Commit | `359d5ca` |',
].join('\n')

const node = {
  number: 2231,
  title: 'fix(workflow): editor top bar',
  body: 'Pairs with globex/voice-bot#88.\n\n```\nsee #1\n```',
  url: 'https://github.com/globex/dashboard/pull/2231',
  state: 'OPEN',
  repository: { nameWithOwner: SLUG },
  isDraft: false,
  headRefName: 'fix/workflow-editor-top-bar',
  baseRefName: 'staging-eu',
  headRefOid: 'f608484c0ffee',
  updatedAt: '2026-09-24T12:42:57Z',
  reviewDecision: 'CHANGES_REQUESTED',
  mergeable: 'MERGEABLE',
  author: { login: 'alice-dev' },
  labels: { nodes: [{ name: 'preview' }] },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: 'FAILURE',
            contexts: {
              nodes: [
                {
                  __typename: 'CheckRun',
                  name: 'test',
                  status: 'COMPLETED',
                  conclusion: 'SUCCESS',
                  detailsUrl: 'https://github.com/x/runs/1',
                },
                { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null, detailsUrl: null },
                {
                  __typename: 'CheckRun',
                  name: 'sonar',
                  status: 'COMPLETED',
                  conclusion: 'CANCELLED',
                  detailsUrl: null,
                },
                { __typename: 'StatusContext', context: 'CodeRabbit', state: 'SUCCESS', targetUrl: null },
              ],
            },
          },
        },
      },
    ],
  },
  comments: {
    nodes: [
      { author: null, body: 'ghost comment, follow-up in #2240', updatedAt: '2026-09-24T10:00:00Z' },
      { author: { login: 'github-actions' }, body: READY, updatedAt: '2026-09-24T12:42:57Z' },
    ],
  },
  reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] },
}

const response = (nodes: unknown[], issueCount = nodes.length, endCursor: string | null = null) =>
  JSON.stringify({
    data: { search: { issueCount, pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
  })

const parsed = (nodes: unknown[]) => parseSearchResponse(response(nodes)).prs

describe('parseSearchResponse', () => {
  it('normalizes a GraphQL pull request', () => {
    const [pr] = parsed([node])
    expect(pr).toMatchObject({
      key: 'dashboard-2231',
      repo_slug: SLUG,
      author: 'alice-dev',
      review_decision: 'changes_requested',
      mergeable: 'mergeable',
      labels: ['preview'],
      ci: 'failure',
      unresolved_threads: 2,
      preview: { state: 'none', url: null, commit: null, stale: false },
      preview_host: null,
    })
    expect(pr?.refs).toEqual([
      { slug: 'globex/voice-bot', number: 88, place: 'body', pull: false },
      { slug: 'globex/dashboard', number: 2240, place: 'comment', pull: false },
    ])
    expect(pr).not.toHaveProperty('repo_id')
    expect(searchQueryArgs().join(' ')).toContain('number title body url')
    expect(searchQueryArgs().join(' ')).toContain('reviewThreads(first: 100) { nodes { isResolved } }')
    expect(pr?.checks).toEqual([
      { name: 'test', state: 'success', detail: 'success', url: 'https://github.com/x/runs/1' },
      { name: 'build', state: 'pending', detail: 'in_progress', url: null },
      { name: 'sonar', state: 'failure', detail: 'cancelled', url: null },
      { name: 'CodeRabbit', state: 'success', detail: 'success', url: null },
    ])
  })

  it('hands each PR and its comments to the PR decorators mods registered', () => {
    const preview = {
      state: 'ready',
      url: 'https://pr-2231-staging.example.com',
      commit: '359d5ca',
      stale: true,
    } as const
    const seen: unknown[] = []
    const dispose = prDecorators.register({
      key: 'test.preview',
      decorate: (subject, comments) => {
        seen.push(subject, comments.at(-1)?.author)
        return { preview, preview_host: 'dashboard-pr-2231.seti.localhost' }
      },
    })
    const [pr] = parsed([node])
    dispose()
    expect(seen).toEqual([{ slug: SLUG, number: 2231, headOid: node.headRefOid }, 'github-actions'])
    expect(pr).toMatchObject({ preview, preview_host: 'dashboard-pr-2231.seti.localhost' })
  })

  it('handles PRs without checks or preview', () => {
    const bare = {
      ...node,
      commits: { nodes: [] },
      comments: { nodes: [] },
      reviewThreads: { nodes: [] },
      reviewDecision: null,
    }
    const [pr] = parsed([bare])
    expect(pr).toMatchObject({ ci: null, checks: [], unresolved_threads: 0, review_decision: null, preview_host: null })
    expect(pr?.preview.state).toBe('none')
  })

  it('rejects output that does not match the schema', () => {
    expect(() => parsed([{ ...node, number: '2231' }])).toThrow()
    expect(() => parsed([{ ...node, reviewThreads: { nodes: [{}] } }])).toThrow()
    expect(() => parseSearchResponse(JSON.stringify({ data: { search: null } }))).toThrow()
  })

  it('names each PR by the repo GitHub reports and counts the PRs beyond the page', () => {
    const elsewhere = {
      ...node,
      number: 7,
      url: 'https://github.com/initech/billing/pull/7',
      repository: { nameWithOwner: 'initech/billing' },
    }
    const found = parseSearchResponse(response([node, {}, elsewhere, { ...node, state: 'MERGED' }], 77))
    expect(found).toMatchObject({ total: 77, next: null })
    expect(parseSearchResponse(response([node], 77, 'Y3Vyc29yOjUw')).next).toBe('Y3Vyc29yOjUw')
    expect(found.prs.map((pr) => [pr.key, pr.repo_slug])).toEqual([
      ['dashboard-2231', SLUG],
      ['billing-7', 'initech/billing'],
    ])
  })
})

describe('parseOpenPrResponse', () => {
  it('keeps the open PRs among the URLs, in any repo', () => {
    const urls = [node.url, 'https://github.com/globex/dashboard/pull/1', 'https://github.com/globex/gone/pull/2']
    const stdout = JSON.stringify({ data: { p0: node, p1: { ...node, number: 1, state: 'CLOSED' }, p2: null } })
    expect(parseOpenPrResponse(urls, stdout).map((pr) => pr.key)).toEqual(['dashboard-2231'])
  })
})

describe('gh arguments', () => {
  it('builds one search for the open PRs of the gh login, without a shell', () => {
    const args = searchQueryArgs()
    expect(args.slice(0, 3)).toEqual(['api', 'graphql', '-f'])
    expect(args[3]).toContain('search(type: ISSUE, query: $q, first: 50, after: $after)')
    expect(args[3]).toContain('pageInfo { hasNextPage endCursor }')
    expect(args.slice(-2)).toEqual(['-f', 'q=is:pr is:open author:@me sort:updated-desc'])
    expect(searchQueryArgs('Y3Vyc29yOjUw').slice(-2)).toEqual(['-f', 'after=Y3Vyc29yOjUw'])
  })

  it('looks linked PRs up by URL with the fields of the search', () => {
    const args = openPrQueryArgs(['https://github.com/globex/dashboard/pull/1'])
    expect(args[3]).toContain('p0: resource(url: $u0) { ... on PullRequest { number title body url state')
    expect(args.slice(-2)).toEqual(['-f', 'u0=https://github.com/globex/dashboard/pull/1'])
  })

  it('builds the label calls on the issues REST API', () => {
    const slug = 'globex/dashboard'
    expect(labelListArgs(slug, 2231)).toEqual([
      'api',
      'repos/globex/dashboard/issues/2231/labels?per_page=100',
      '--jq',
      '.[].name',
    ])
    expect(labelAddArgs(slug, 2231, 'preview')).toEqual([
      'api',
      '--method',
      'POST',
      'repos/globex/dashboard/issues/2231/labels',
      '-f',
      'labels[]=preview',
    ])
    expect(labelRemoveArgs(slug, 2231, 'needs review')).toEqual([
      'api',
      '--method',
      'DELETE',
      'repos/globex/dashboard/issues/2231/labels/needs%20review',
    ])
  })
})

describe('addPreviewLabel', () => {
  const slug = 'globex/dashboard'

  beforeEach(() => {
    gh.calls = []
    gh.labels = ''
    gh.failOn = ''
  })

  it('adds the label when the PR does not have it', async () => {
    gh.labels = 'bug\nfrontend\n'
    expect(await addPreviewLabel(slug, 2231)).toBe(false)
    expect(gh.calls).toEqual([labelListArgs(slug, 2231), labelAddArgs(slug, 2231, 'preview')])
  })

  it('removes a present label first so GitHub sends a new labeled event', async () => {
    gh.labels = 'bug\nPreview\n'
    expect(await addPreviewLabel(slug, 2231)).toBe(true)
    expect(gh.calls).toEqual([
      labelListArgs(slug, 2231),
      labelRemoveArgs(slug, 2231, 'preview'),
      labelAddArgs(slug, 2231, 'preview'),
    ])
  })

  it('stops with the gh error when removing the label fails', async () => {
    gh.labels = 'preview\n'
    gh.failOn = 'DELETE'
    await expect(addPreviewLabel(slug, 2231)).rejects.toThrow('HTTP 403: Resource not accessible')
    expect(gh.calls).toHaveLength(2)
  })
})

describe('watched PRs', () => {
  const url = 'https://github.com/acme/web/pull/7'
  const watchedNode = {
    url,
    number: 7,
    state: 'OPEN',
    mergeable: 'CONFLICTING',
    closedAt: null,
    repository: { nameWithOwner: 'acme/web' },
    commits: {
      nodes: [
        {
          commit: {
            oid: 'abc1234def',
            statusCheckRollup: {
              state: 'FAILURE',
              contexts: {
                nodes: [
                  { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'd' },
                ],
              },
            },
          },
        },
      ],
    },
    reviews: {
      nodes: [
        {
          id: 'R1',
          state: 'CHANGES_REQUESTED',
          body: 'Rename it',
          url: 'r',
          submittedAt: '2026-10-07T10:00:00Z',
          author: { __typename: 'Bot', login: 'coderabbitai' },
          comments: { nodes: [{ path: 'a.ts', line: null, originalLine: 4, body: 'here', url: 'c' }] },
        },
      ],
    },
    comments: { nodes: [{ id: 'C1', body: 'hi', url: 'u', createdAt: '2026-10-07T10:01:00Z', author: null }] },
  }

  it('maps each alias back to its URL and reads the parts updates need', () => {
    const other = 'https://github.com/acme/web/pull/8'
    const gone = 'https://github.com/acme/web/pull/9'
    const found = parseWatchResponse(
      [url, other, gone],
      JSON.stringify({ data: { p0: watchedNode, p1: {}, p2: null } }),
    )
    expect(found.get(other)).toBeNull()
    expect(found.get(gone)).toBeNull()
    expect(found.get(url)).toEqual({
      url,
      subject: 'acme/web#7',
      state: 'open',
      closed_at: null,
      conflicting: true,
      head_oid: 'abc1234def',
      ci: 'failure',
      checks: [{ name: 'test', state: 'failure', detail: 'failure', url: 'd' }],
      reviews: [
        {
          id: 'R1',
          state: 'CHANGES_REQUESTED',
          body: 'Rename it',
          url: 'r',
          submitted_at: '2026-10-07T10:00:00Z',
          author: { login: 'coderabbitai', bot: true },
          comments: [{ path: 'a.ts', line: 4, body: 'here', url: 'c' }],
        },
      ],
      comments: [{ id: 'C1', body: 'hi', url: 'u', created_at: '2026-10-07T10:01:00Z', author: null }],
    })
  })

  it('rejects a PR node that does not match the expected shape', () => {
    expect(() =>
      parseWatchResponse([url], JSON.stringify({ data: { p0: { ...watchedNode, state: 'DRAFT' } } })),
    ).toThrow()
  })

  it('passes URLs as GraphQL variables, never inside the query text', () => {
    const args = watchQueryArgs([url, 'https://github.com/acme/api/pull/2'])
    const query = args[3] ?? ''
    expect(args.slice(0, 3)).toEqual(['api', 'graphql', '-f'])
    expect(query).toMatch(/^query=query\(\$u0: URI!, \$u1: URI!\)/)
    expect(query).toContain('p1: resource(url: $u1) { ... on PullRequest {')
    expect(query).not.toContain('github.com')
    expect(args.slice(4)).toEqual(['-f', `u0=${url}`, '-f', 'u1=https://github.com/acme/api/pull/2'])
  })
})
