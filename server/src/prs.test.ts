import type { Preview, Repo } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenPr } from './github.js'
import type * as Prs from './prs.js'

const gh = vi.hoisted(() => ({
  fetchOpenPrs: vi.fn<(repo: { id: string; slug: string }) => Promise<OpenPr[]>>(),
  addPreviewLabel: vi.fn<(slug: string, number: number) => Promise<boolean>>(),
}))

const REPO: Repo = {
  id: 'r1',
  slug: 'globex/dashboard',
  path: '/srv/dash',
  base_branch: 'staging-eu',
  created_at: '2026-09-01T00:00:00Z',
}

vi.mock('./db.js', () => ({
  repos: { list: async () => Promise.resolve([REPO]) },
  closeDatabase: async () => Promise.resolve(),
}))
vi.mock('./store/prs.js', () => ({
  tasksByPrUrl: async () =>
    Promise.resolve(new Map([['https://github.com/pr/1', [{ id: 't1', title: 'Fix it', status: 'idle' as const }]]])),
}))
vi.mock('./github.js', () => ({
  fetchOpenPrs: gh.fetchOpenPrs,
  addPreviewLabel: gh.addPreviewLabel,
  viewerLogin: async () => Promise.resolve('Octocat'),
}))

const NO_PREVIEW: Preview = { state: 'none', url: null, commit: null, stale: false }

function pr(number: number, author: string, preview: Preview = NO_PREVIEW): OpenPr {
  return {
    key: `dashboard-${String(number)}`,
    repo_id: REPO.id,
    repo_slug: REPO.slug,
    number,
    title: `PR ${String(number)}`,
    url: `https://github.com/pr/${String(number)}`,
    draft: false,
    author,
    head_ref: 'feat/x',
    base_ref: 'staging-eu',
    head_oid: 'abc1234',
    updated_at: '2026-09-26T00:00:00Z',
    review_decision: null,
    mergeable: 'unknown',
    labels: [],
    ci: null,
    checks: [],
    unresolved_threads: 0,
    preview,
    preview_host: preview.state === 'ready' ? `dashboard-pr-${String(number)}.seti.localhost` : null,
    refs: [],
  }
}

const READY: Preview = { state: 'ready', url: 'https://pr-2-staging.example.com', commit: 'abc1234', stale: false }
const STALE: Preview = { ...READY, url: 'https://pr-3-staging.example.com', stale: true }
const PRS = [pr(1, 'octocat'), pr(2, 'someone', READY), pr(3, 'Octocat', STALE)]

let clock = 1_000_000

/** A fresh module holds no cached list, as after a restart. */
async function freshProcess() {
  vi.resetModules()
  return import('./prs.js')
}

let prs: typeof Prs

beforeEach(async () => {
  clock += 10 * 60_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  gh.fetchOpenPrs.mockReset().mockResolvedValue(PRS)
  gh.addPreviewLabel.mockReset().mockResolvedValue(false)
  prs = await freshProcess()
  await prs.listPrs('all')
  gh.fetchOpenPrs.mockClear()
})

describe('listPrs', () => {
  it('filters by the gh viewer ignoring case and attaches linked tasks', async () => {
    const list = await prs.listPrs('mine')
    const [group] = list.repos
    expect(group?.prs.map((p) => p.number)).toEqual([1, 3])
    expect(group?.prs[0]?.tasks).toEqual([{ id: 't1', title: 'Fix it', status: 'idle' }])
    expect(group?.previews).toBe(true)
    expect(gh.fetchOpenPrs).not.toHaveBeenCalled()
  })

  it('serves a stale list while one shared call refreshes it', async () => {
    clock += 61_000
    gh.fetchOpenPrs.mockResolvedValue([pr(9, 'Octocat')])
    const [first, second] = await Promise.all([prs.listPrs('all'), prs.listPrs('all')])
    expect(first.repos[0]?.prs).toHaveLength(3)
    expect(second.repos[0]?.prs).toHaveLength(3)
    expect(gh.fetchOpenPrs).toHaveBeenCalledTimes(1)
    await vi.waitFor(async () => {
      expect((await prs.listPrs('all')).repos[0]?.prs.map((p) => p.number)).toEqual([9])
    })
  })

  it('relates PRs across scopes', async () => {
    const mine = await prs.listPrs('mine')
    expect(mine.repos[0]?.prs[0]?.related.map((r) => [r.key, r.reasons])).toEqual([
      ['dashboard-2', [{ type: 'same_branch', branch: 'feat/x' }]],
      ['dashboard-3', [{ type: 'same_branch', branch: 'feat/x' }]],
    ])
    expect(mine.repos[0]?.prs[0]).not.toHaveProperty('refs')
  })

  it('reports gh errors per repo when nothing is cached', async () => {
    gh.fetchOpenPrs.mockRejectedValue(new Error('gh: not logged in'))
    const list = await (await freshProcess()).listPrs('all')
    expect(list.repos[0]).toMatchObject({ error: 'gh: not logged in', prs: [] })
  })
})

describe('lookupPrs', () => {
  it('resolves many URLs from one cached list, leaving out closed or unknown ones', async () => {
    const unknown = Array.from({ length: 200 }, (_, n) => `https://example.test/x/pull/${String(n)}`)
    const found = await prs.lookupPrs([...PRS.map((p) => p.url), ...unknown])
    expect(found.map((p) => p.number)).toEqual([1, 2, 3])
    expect(found[0]?.tasks).toEqual([{ id: 't1', title: 'Fix it', status: 'idle' }])
    expect(found[0]).not.toHaveProperty('refs')
    expect(gh.fetchOpenPrs).not.toHaveBeenCalled()
    expect(await prs.lookupPrs([])).toEqual([])
  })
})

describe('PR decorators', () => {
  it('fetches the list again when the decorators change, and says whether previews are on', async () => {
    const { prDecorators } = await import('./pr-decorators.js')
    expect((await prs.listPrs('all')).previews_on).toBe(false)
    const dispose = prDecorators.register({ key: 'test.preview', decorate: () => ({}) })
    expect((await prs.listPrs('all')).previews_on).toBe(true)
    expect(gh.fetchOpenPrs).toHaveBeenCalledTimes(1)
    dispose()
    expect((await prs.listPrs('all')).previews_on).toBe(false)
    expect(gh.fetchOpenPrs).toHaveBeenCalledTimes(1)
  })
})

describe('redeployPreview', () => {
  it('labels only open PRs of registered repos', async () => {
    await expect(prs.redeployPreview('someone', 'else', 2)).rejects.toThrow('not registered')
    await expect(prs.redeployPreview('globex', 'dashboard', 99)).rejects.toThrow('Not an open')
    expect(gh.addPreviewLabel).not.toHaveBeenCalled()
    expect(await prs.redeployPreview('GloBex', 'dashboard', 2)).toBe(false)
    expect(gh.addPreviewLabel).toHaveBeenCalledWith('globex/dashboard', 2)
  })

  it('reports a re-added label and refetches the repo on the next list', async () => {
    gh.addPreviewLabel.mockResolvedValue(true)
    expect(await prs.redeployPreview('globex', 'dashboard', 3)).toBe(true)
    await prs.listPrs('all')
    expect(gh.fetchOpenPrs).toHaveBeenCalledTimes(1)
  })
})
