import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthoredPage, OpenPr } from './github.js'
import { cache, redisReady } from './redis.js'

vi.hoisted(() => {
  process.env.SETI_REDIS_URL = process.env.SETI_TEST_REDIS_URL ?? '/run/seti-redis/redis.sock'
})

const gh = vi.hoisted(() => ({ fetchAuthoredPage: vi.fn<() => Promise<AuthoredPage>>() }))

vi.mock('./db.js', () => ({
  repos: { list: async () => Promise.resolve([]) },
  closeDatabase: async () => Promise.resolve(),
}))
vi.mock('./store/prs.js', () => ({
  tasksByPrUrl: async () => Promise.resolve(new Map()),
  linkedPrUrls: async () => Promise.resolve([]),
}))
vi.mock('./github.js', () => ({
  fetchAuthoredPage: gh.fetchAuthoredPage,
  fetchOpenPrsByUrl: async () => Promise.resolve([]),
  addPreviewLabel: vi.fn(),
  viewerLogin: async () => Promise.resolve('me'),
}))

const pr = (number: number): OpenPr => ({
  key: `shared-${String(number)}`,
  repo_slug: 'e2e/shared',
  number,
  title: `PR ${String(number)}`,
  url: `https://github.com/e2e/shared/pull/${String(number)}`,
  draft: false,
  author: 'me',
  head_ref: 'feat/x',
  base_ref: 'main',
  head_oid: 'abc',
  updated_at: '2026-09-26T00:00:00Z',
  review_decision: null,
  mergeable: 'unknown',
  labels: [],
  ci: null,
  checks: [],
  unresolved_threads: 0,
  preview: { state: 'none', url: null, commit: null, stale: false },
  preview_host: null,
  refs: [],
})

/** A fresh module is what another process, or this one after a restart, starts with. */
async function freshProcess() {
  vi.resetModules()
  return import('./prs.js')
}

beforeAll(async () => {
  expect(await redisReady(5000)).toBe(true)
})

beforeEach(async () => {
  gh.fetchAuthoredPage.mockReset().mockResolvedValue({ prs: [pr(1), pr(2)], total: 2, next: null })
  await cache.del('gh:prs:v3:')
})

describe('PR lists shared through Redis', () => {
  it('serves a list another process fetched without asking GitHub again', async () => {
    const first = await freshProcess()
    await first.listPrs()
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)

    const second = await freshProcess()
    const list = await second.listPrs()
    expect(list.prs.map((p) => p.number)).toEqual([1, 2])
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)
  })
})
