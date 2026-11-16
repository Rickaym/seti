import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListedRow, ListedStatus, SearchPage } from './github-list.js'
import type { OpenPr } from './github.js'
import { cache, redisReady } from './redis.js'

vi.hoisted(() => {
  process.env.SETI_REDIS_URL = process.env.SETI_TEST_REDIS_URL ?? '/run/seti-redis/redis.sock'
})

const gh = vi.hoisted(() => ({
  fetchRowPage: vi.fn<() => Promise<SearchPage<ListedRow>>>(),
  fetchStatusPage: vi.fn<() => Promise<SearchPage<ListedStatus>>>(),
  fetchPrDetails: vi.fn<(urls: readonly string[]) => Promise<Map<string, OpenPr | null>>>(),
}))

vi.mock('./db.js', () => ({
  repos: { list: async () => Promise.resolve([]) },
  closeDatabase: async () => Promise.resolve(),
}))
vi.mock('./store/prs.js', () => ({
  tasksByPrUrl: async () => Promise.resolve(new Map()),
  linkedPrUrls: async () => Promise.resolve([]),
}))
vi.mock('./store/pr-list.js', () => ({
  prListStore: { read: async () => Promise.resolve(undefined), write: async () => Promise.resolve() },
}))
vi.mock('./github-cache.js', () => ({ canPollGithub: async () => Promise.resolve(true) }))
vi.mock('./github-list.js', () => ({ fetchRowPage: gh.fetchRowPage, fetchStatusPage: gh.fetchStatusPage }))
vi.mock('./github.js', () => ({
  fetchPrDetails: gh.fetchPrDetails,
  addPreviewLabel: vi.fn(),
  viewerLogin: async () => Promise.resolve('me'),
}))

const url = (number: number) => `https://github.com/e2e/shared/pull/${String(number)}`

const row = (number: number): ListedRow => ({
  key: `shared-${String(number)}`,
  repo_slug: 'e2e/shared',
  number,
  title: `PR ${String(number)}`,
  url: url(number),
  draft: false,
  author: 'me',
  head_ref: 'feat/x',
  base_ref: 'main',
  updated_at: '2026-09-26T00:00:00Z',
})

const detail = (number: number): OpenPr => ({
  ...row(number),
  head_oid: 'abc',
  review_decision: null,
  mergeable: 'unknown',
  labels: [],
  ci: null,
  checks: [],
  unresolved_threads: 3,
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
  gh.fetchRowPage.mockReset().mockResolvedValue({ items: [row(1), row(2)], total: 2, next: null })
  gh.fetchStatusPage.mockReset().mockResolvedValue({ items: [], total: 2, next: null })
  gh.fetchPrDetails
    .mockReset()
    .mockImplementation(async (urls) =>
      Promise.resolve(new Map(urls.map((asked) => [asked, detail(Number(asked.split('/').at(-1)))]))),
    )
  await cache.del('gh:prs:v4', `gh:pr:v1::${url(1)}`, `gh:pr:v1::${url(2)}`)
})

describe('PR lists and detail shared through Redis', () => {
  it('serves a list and detail another process read without asking GitHub again', async () => {
    const first = await freshProcess()
    expect((await first.lookupPrs([url(1)])).prs[0]?.unresolved_threads).toBe(3)
    expect(gh.fetchRowPage).toHaveBeenCalledTimes(1)
    expect(gh.fetchPrDetails).toHaveBeenCalledTimes(1)

    const second = await freshProcess()
    expect((await second.listPrs()).prs.map((p) => p.number)).toEqual([1, 2])
    expect((await second.lookupPrs([url(1)])).prs[0]?.unresolved_threads).toBe(3)
    expect(gh.fetchRowPage).toHaveBeenCalledTimes(1)
    expect(gh.fetchPrDetails).toHaveBeenCalledTimes(1)
  })
})
