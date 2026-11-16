import { describe, expect, it } from 'vitest'
import { LIST_PAGE, parseRowPage, parseStatusPage, rowQueryArgs, statusQueryArgs } from './github-list.js'

const row = {
  number: 12,
  title: 'Ship the landing page',
  url: 'https://github.com/faraway/site/pull/12',
  state: 'OPEN',
  isDraft: true,
  headRefName: 'feat/landing',
  baseRefName: 'main',
  updatedAt: '2026-10-07T09:00:00Z',
  repository: { nameWithOwner: 'faraway/site' },
  author: { login: 'octocat' },
}

const status = (state: string | null, over: Record<string, unknown> = {}) => ({
  url: row.url,
  state: 'OPEN',
  reviewDecision: 'APPROVED',
  mergeable: 'CONFLICTING',
  commits: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] },
  ...over,
})

const page = (nodes: unknown[], issueCount = nodes.length, endCursor: string | null = null) =>
  JSON.stringify({
    data: { search: { issueCount, pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
  })

describe('the row search', () => {
  it('reads a slim row per open PR, named by the repo GitHub reports', () => {
    const found = parseRowPage(page([row, {}, { ...row, number: 13, state: 'MERGED' }], 86, 'Y3Vyc29yOjEwMA=='))
    expect(found).toMatchObject({ total: 86, next: 'Y3Vyc29yOjEwMA==' })
    expect(found.items).toEqual([
      {
        key: 'site-12',
        repo_slug: 'faraway/site',
        number: 12,
        title: 'Ship the landing page',
        url: row.url,
        draft: true,
        author: 'octocat',
        head_ref: 'feat/landing',
        base_ref: 'main',
        updated_at: '2026-10-07T09:00:00Z',
      },
    ])
    expect(parseRowPage(page([row])).next).toBeNull()
    expect(() => parseRowPage(page([{ ...row, number: '12' }]))).toThrow()
  })

  it('asks for a page of 100 rows with none of the slow or heavy fields', () => {
    const args = rowQueryArgs()
    expect(LIST_PAGE).toBe(100)
    expect(args.slice(0, 3)).toEqual(['api', 'graphql', '-f'])
    expect(args[3]).toContain('search(type: ISSUE, query: $q, first: 100, after: $after)')
    for (const slow of ['statusCheckRollup', 'reviewDecision', 'mergeable', 'comments', 'reviewThreads', 'body']) {
      expect(args[3]).not.toContain(slow)
    }
    expect(args.slice(-2)).toEqual(['-f', 'q=is:pr is:open author:@me sort:updated-desc'])
    expect(rowQueryArgs('Y3Vyc29y').slice(-2)).toEqual(['-f', 'after=Y3Vyc29y'])
  })
})

describe('the status search', () => {
  it('reads review, conflicts and the check rollup as one value per PR', () => {
    const found = parseStatusPage(
      page([status('FAILURE'), status(null, { reviewDecision: null, mergeable: 'UNKNOWN' })]),
    )
    expect(found.items).toEqual([
      { url: row.url, review_decision: 'approved', mergeable: 'conflicting', ci: 'failure' },
      { url: row.url, review_decision: null, mergeable: 'unknown', ci: null },
    ])
    expect(parseStatusPage(page([status('PENDING')])).items[0]?.ci).toBe('pending')
  })

  it('selects the rollup state alone, never each check', () => {
    const query = statusQueryArgs()[3] ?? ''
    expect(query).toContain('statusCheckRollup { state }')
    expect(query).not.toContain('contexts')
  })
})
