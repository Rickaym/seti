import type { LinkedPrState, PullRequest } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { filterLinkedPrs, orderLinkedPrs } from './linked-prs'

const url = (repo: string, number: number) => `https://github.com/e2e/${repo}/pull/${String(number)}`

function pr(repo: string, number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    key: `${repo}-${String(number)}`,
    repo_id: `e2e/${repo}`,
    repo_slug: `e2e/${repo}`,
    number,
    title: `${repo} change ${String(number)}`,
    url: url(repo, number),
    draft: false,
    author: 'e2e',
    head_ref: `feat/${String(number)}`,
    base_ref: 'main',
    head_oid: 'abc1234def',
    updated_at: '2026-10-03T10:00:00Z',
    review_decision: null,
    mergeable: 'mergeable',
    labels: [],
    ci: 'success',
    checks: [],
    unresolved_threads: 0,
    preview: { state: 'none', url: null, commit: null, stale: false },
    preview_host: null,
    tasks: [],
    related: [],
    ...over,
  }
}

const statusMap = (...prs: PullRequest[]) => new Map(prs.map((p) => [p.url, p]))

describe('orderLinkedPrs', () => {
  it('puts PRs to fix first, then open, merged and closed', () => {
    const urls = [url('web', 1), url('web', 2), url('web', 3), url('web', 4), url('web', 5), url('web', 6)]
    const statuses = statusMap(
      pr('web', 2),
      pr('web', 4, { ci: 'failure' }),
      pr('web', 6, { mergeable: 'conflicting' }),
    )
    const states: Record<string, LinkedPrState> = { [url('web', 1)]: 'closed', [url('web', 3)]: 'merged' }
    const ordered = orderLinkedPrs(urls, statuses, states, 'e2e/web')
    expect(ordered.map((item) => [item.label, item.group])).toEqual([
      ['#6', 'fix'],
      ['#4', 'fix'],
      ['#2', 'open'],
      ['#5', 'open'],
      ['#3', 'merged'],
      ['#1', 'closed'],
    ])
  })

  it('orders open PRs by last update, then the most recently linked of the rest first', () => {
    const urls = [url('api', 1), url('api', 2), url('api', 3), url('api', 4)]
    const statuses = statusMap(
      pr('api', 1, { updated_at: '2026-10-04T00:00:00Z' }),
      pr('api', 2, { updated_at: '2026-10-01T00:00:00Z' }),
    )
    const states: Record<string, LinkedPrState> = { [url('api', 3)]: 'merged', [url('api', 4)]: 'merged' }
    const ordered = orderLinkedPrs(urls, statuses, states, null)
    expect(ordered.map((item) => item.label)).toEqual(['api#1', 'api#2', 'api#4', 'api#3'])
    expect(ordered[0]).toMatchObject({ slug: 'e2e/api', number: 1 })
  })

  it('counts a PR with no status and no polled state as open', () => {
    const [only] = orderLinkedPrs([url('web', 9)], new Map(), {}, 'e2e/web')
    expect(only).toMatchObject({ group: 'open', pr: null, label: '#9' })
  })
})

describe('filterLinkedPrs', () => {
  const urls = Array.from({ length: 150 }, (_, n) => url(n % 2 === 0 ? 'web' : 'api', n + 1))
  const all = orderLinkedPrs(urls, statusMap(pr('web', 41, { title: 'Fix login redirect' })), {}, 'e2e/web')

  it('keeps everything for an empty query', () => {
    expect(filterLinkedPrs(all, '  ')).toHaveLength(150)
  })

  it('matches by number, with or without the hash', () => {
    expect(filterLinkedPrs(all, `#${String(141)}`).map((item) => item.number)).toEqual([141])
    expect(filterLinkedPrs(all, '14').map((item) => item.number)).toEqual(
      expect.arrayContaining([14, 114, 140, 141, 149]),
    )
  })

  it('matches by repo and title, every word required, ignoring case', () => {
    expect(filterLinkedPrs(all, 'API').every((item) => item.slug === 'e2e/api')).toBe(true)
    expect(filterLinkedPrs(all, 'api')).toHaveLength(75)
    expect(filterLinkedPrs(all, 'login web').map((item) => item.number)).toEqual([41])
    expect(filterLinkedPrs(all, 'login api')).toEqual([])
  })
})
