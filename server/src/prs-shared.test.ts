import type { Repo } from '@seti/shared'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenPr } from './github.js'
import { cache, redisReady } from './redis.js'

vi.hoisted(() => {
  process.env.SETI_REDIS_URL = process.env.SETI_TEST_REDIS_URL ?? '/run/seti-redis/redis.sock'
})

const gh = vi.hoisted(() => ({ fetchOpenPrs: vi.fn<(repo: { id: string; slug: string }) => Promise<OpenPr[]>>() }))

const REPO: Repo = {
  id: 'shared-r1',
  slug: 'e2e/shared',
  path: '/srv/shared',
  base_branch: 'main',
  created_at: '2026-09-01T00:00:00Z',
}

vi.mock('./db.js', () => ({
  repos: { list: async () => Promise.resolve([REPO]) },
  closeDatabase: async () => Promise.resolve(),
}))
vi.mock('./store/prs.js', () => ({ tasksByPrUrl: async () => Promise.resolve(new Map()) }))
vi.mock('./github.js', () => ({
  fetchOpenPrs: gh.fetchOpenPrs,
  addPreviewLabel: vi.fn(),
  viewerLogin: async () => Promise.resolve('me'),
}))

const pr = (number: number): OpenPr => ({
  key: `shared-${String(number)}`,
  repo_id: REPO.id,
  repo_slug: REPO.slug,
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
  gh.fetchOpenPrs.mockReset().mockResolvedValue([pr(1), pr(2)])
  await cache.del(`gh:prs:v2:${REPO.id}:${REPO.slug}`)
})

describe('PR lists shared through Redis', () => {
  it('serves a list another process fetched without asking GitHub again', async () => {
    const first = await freshProcess()
    await first.listPrs('all')
    expect(gh.fetchOpenPrs).toHaveBeenCalledTimes(1)

    const second = await freshProcess()
    const list = await second.listPrs('all')
    expect(list.repos[0]?.prs.map((p) => p.number)).toEqual([1, 2])
    expect(gh.fetchOpenPrs).toHaveBeenCalledTimes(1)
  })
})
