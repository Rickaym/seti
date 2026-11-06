import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedPrHeads, canPollGithub, POLL_BUDGET_FLOOR } from './github-cache.js'
import { redisReady } from './redis.js'

vi.hoisted(() => {
  process.env.SETI_REDIS_URL = process.env.SETI_TEST_REDIS_URL ?? '/run/seti-redis/redis.sock'
})

const gh = vi.hoisted(() => ({
  fetchPrHeads: vi.fn(async (urls: readonly string[]) =>
    Promise.resolve(
      new Map(
        urls.map((url) => [url, url.endsWith('/issues/1') ? null : { url, head_ref: 'fix/x', head_repo: 'e2e/web' }]),
      ),
    ),
  ),
  run: vi.fn(async (_args: string[]) => Promise.resolve(JSON.stringify({ limit: 5000, remaining: 4000, reset: 0 }))),
}))

vi.mock('./github.js', () => ({ fetchPrHeads: gh.fetchPrHeads, gh: gh.run }))

beforeAll(async () => {
  expect(await redisReady(5000)).toBe(true)
})

beforeEach(() => {
  gh.fetchPrHeads.mockClear()
  gh.run.mockClear()
})

describe('shared GitHub lookups', () => {
  it('asks GitHub once per PR URL across callers, and remembers URLs that are no PR', async () => {
    const pr = 'https://github.com/e2e/web/pull/7'
    const issue = 'https://github.com/e2e/web/issues/1'
    const first = await cachedPrHeads([pr, issue])
    expect(first.get(pr)?.head_ref).toBe('fix/x')
    expect(first.get(issue)).toBeNull()
    const again = await cachedPrHeads([issue, pr, 'https://github.com/e2e/web/pull/8'])
    expect(new Set(again.keys())).toEqual(new Set([pr, 'https://github.com/e2e/web/pull/8', issue]))
    expect(again.get(issue)).toBeNull()
    expect(gh.fetchPrHeads.mock.calls).toEqual([[[pr, issue]], [['https://github.com/e2e/web/pull/8']]])
  })

  it('stops the poller while the budget is low, until GitHub refills it', async () => {
    const now = Date.parse('2026-09-27T12:00:00Z')
    const reset = now / 1000 + 600
    gh.run.mockResolvedValue(JSON.stringify({ limit: 5000, used: 4501, remaining: POLL_BUDGET_FLOOR - 1, reset }))
    const { cache } = await import('./redis.js')
    await cache.del('gh:budget:graphql')
    expect(await canPollGithub(now)).toBe(false)
    expect(await canPollGithub(now + 30_000)).toBe(false)
    expect(gh.run).toHaveBeenCalledTimes(1)
    expect(gh.run).toHaveBeenCalledWith(['api', 'rate_limit', '--jq', '.resources.graphql'])
    expect(await canPollGithub(now + 601_000)).toBe(true)
  })
})
