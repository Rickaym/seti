import type { Preview } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthoredPrs, OpenPr } from './github.js'
import type * as Prs from './prs.js'

const gh = vi.hoisted(() => ({
  fetchAuthoredPrs: vi.fn<() => Promise<AuthoredPrs>>(),
  fetchOpenPrsByUrl: vi.fn<(urls: readonly string[]) => Promise<OpenPr[]>>(),
  addPreviewLabel: vi.fn<(slug: string, number: number) => Promise<boolean>>(),
}))
const linked = vi.hoisted(() => ({ urls: [] as string[] }))

const SLUG = 'globex/dashboard'

vi.mock('./db.js', () => ({
  repos: { list: async () => Promise.resolve([]) },
  closeDatabase: async () => Promise.resolve(),
}))
vi.mock('./store/prs.js', () => ({
  tasksByPrUrl: async () =>
    Promise.resolve(new Map([['https://github.com/pr/1', [{ id: 't1', title: 'Fix it', status: 'idle' as const }]]])),
  linkedPrUrls: async () => Promise.resolve(linked.urls),
}))
vi.mock('./github.js', () => ({
  fetchAuthoredPrs: gh.fetchAuthoredPrs,
  fetchOpenPrsByUrl: gh.fetchOpenPrsByUrl,
  addPreviewLabel: gh.addPreviewLabel,
  viewerLogin: async () => Promise.resolve('Octocat'),
}))

const NO_PREVIEW: Preview = { state: 'none', url: null, commit: null, stale: false }

function pr(number: number, author: string, preview: Preview = NO_PREVIEW, slug = SLUG): OpenPr {
  return {
    key: `${slug.split('/').at(-1) ?? slug}-${String(number)}`,
    repo_slug: slug,
    number,
    title: `PR ${String(number)}`,
    url: `https://github.com/pr/${String(number)}`,
    draft: false,
    author,
    head_ref: slug === SLUG ? 'feat/x' : `feat/${String(number)}`,
    base_ref: 'staging-eu',
    head_oid: 'abc1234',
    updated_at: `2026-09-26T00:00:${String(60 - number).padStart(2, '0')}Z`,
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
const PRS = [pr(1, 'octocat'), pr(2, 'octocat', READY), pr(3, 'Octocat', STALE)]
/** A PR an agent linked that someone else wrote, in a repo Seti has no checkout of. */
const LINKED = pr(7, 'someone', NO_PREVIEW, 'initech/billing')

let clock = 1_000_000

/** A fresh module holds no cached list, as after a restart. */
async function freshProcess() {
  vi.resetModules()
  return import('./prs.js')
}

let prs: typeof Prs

const numbers = (list: { prs: { number: number }[] }) => list.prs.map((p) => p.number)

beforeEach(async () => {
  clock += 10 * 60_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  linked.urls = [PRS[0]?.url ?? '', LINKED.url]
  gh.fetchAuthoredPrs.mockReset().mockResolvedValue({ prs: PRS, total: 5 })
  gh.fetchOpenPrsByUrl
    .mockReset()
    .mockImplementation(async (urls) => Promise.resolve([LINKED].filter((open) => urls.includes(open.url))))
  gh.addPreviewLabel.mockReset().mockResolvedValue(false)
  prs = await freshProcess()
  await prs.listPrs()
  gh.fetchAuthoredPrs.mockClear()
  gh.fetchOpenPrsByUrl.mockClear()
})

describe('listPrs', () => {
  it('merges the search for the login with the linked PRs it left out, in one list', async () => {
    prs = await freshProcess()
    const list = await prs.listPrs()
    expect(numbers(list)).toEqual([1, 2, 3, 7])
    expect(list).toMatchObject({ viewer: 'Octocat', error: null, more: 2 })
    expect(list.prs[0]?.tasks).toEqual([{ id: 't1', title: 'Fix it', status: 'idle' }])
    expect(list.prs[3]).toMatchObject({ repo_slug: 'initech/billing', author: 'someone' })
    expect(gh.fetchAuthoredPrs).toHaveBeenCalledTimes(1)
    expect(gh.fetchOpenPrsByUrl.mock.calls).toEqual([[[LINKED.url]]])
  })

  it('serves a stale list while one shared call refreshes it', async () => {
    clock += 61_000
    gh.fetchAuthoredPrs.mockResolvedValue({ prs: [pr(9, 'Octocat')], total: 1 })
    const [first, second] = await Promise.all([prs.listPrs(), prs.listPrs()])
    expect(first.prs).toHaveLength(4)
    expect(second.prs).toHaveLength(4)
    expect(gh.fetchAuthoredPrs).toHaveBeenCalledTimes(1)
    await vi.waitFor(async () => {
      expect(numbers(await prs.listPrs())).toEqual([7, 9])
    })
  })

  it('relates the listed PRs to each other', async () => {
    const list = await prs.listPrs()
    expect(list.prs[0]?.related.map((r) => [r.key, r.reasons])).toEqual([
      ['dashboard-2', [{ type: 'same_branch', branch: 'feat/x' }]],
      ['dashboard-3', [{ type: 'same_branch', branch: 'feat/x' }]],
    ])
    expect(list.prs[0]).not.toHaveProperty('refs')
  })

  it('reports the gh error when nothing is cached', async () => {
    gh.fetchAuthoredPrs.mockRejectedValue(new Error('gh: not logged in'))
    const list = await (await freshProcess()).listPrs()
    expect(list).toMatchObject({ error: 'gh: not logged in', prs: [], more: 0 })
  })
})

describe('lookupPrs', () => {
  it('resolves many URLs from one cached list, leaving out closed or unknown ones', async () => {
    const unknown = Array.from({ length: 200 }, (_, n) => `https://example.test/x/pull/${String(n)}`)
    const found = await prs.lookupPrs([...PRS.map((p) => p.url), LINKED.url, ...unknown])
    expect(found.map((p) => p.number)).toEqual([1, 2, 3, 7])
    expect(found[0]?.tasks).toEqual([{ id: 't1', title: 'Fix it', status: 'idle' }])
    expect(found[0]).not.toHaveProperty('refs')
    expect(gh.fetchAuthoredPrs).not.toHaveBeenCalled()
    expect(await prs.lookupPrs([])).toEqual([])
  })

  it('asks GitHub again for a PR linked after the list was read, once', async () => {
    const fresh = pr(8, 'someone', NO_PREVIEW, 'initech/billing')
    linked.urls = [...linked.urls, fresh.url]
    gh.fetchOpenPrsByUrl.mockResolvedValue([LINKED, fresh])
    expect((await prs.lookupPrs([fresh.url])).map((p) => p.key)).toEqual(['billing-8'])
    expect(gh.fetchAuthoredPrs).toHaveBeenCalledTimes(1)
    await prs.lookupPrs([fresh.url])
    expect(gh.fetchAuthoredPrs).toHaveBeenCalledTimes(1)
  })

  it('does not ask again for a linked PR that GitHub does not show as open', async () => {
    const gone = 'https://github.com/initech/billing/pull/99'
    linked.urls = [...linked.urls, gone]
    expect(await prs.lookupPrs([gone])).toEqual([])
    expect(await prs.lookupPrs([gone])).toEqual([])
    expect(gh.fetchAuthoredPrs).toHaveBeenCalledTimes(1)
  })
})

describe('findPr', () => {
  it('reads an open PR that is neither listed nor linked straight from GitHub', async () => {
    const stray = pr(11, 'someone', NO_PREVIEW, 'umbrella/tools')
    gh.fetchOpenPrsByUrl.mockResolvedValue([stray])
    expect(await prs.findPr(stray.url)).toMatchObject({ key: 'tools-11', tasks: [], related: [] })
    expect(gh.fetchAuthoredPrs).not.toHaveBeenCalled()
    gh.fetchOpenPrsByUrl.mockResolvedValue([])
    expect(await prs.findPr('https://github.com/umbrella/tools/pull/12')).toBeNull()
  })
})

describe('PR decorators', () => {
  it('fetches the list again when the decorators change, and says whether previews are on', async () => {
    const { prDecorators } = await import('./pr-decorators.js')
    expect((await prs.listPrs()).previews_on).toBe(false)
    const dispose = prDecorators.register({ key: 'test.preview', decorate: () => ({}) })
    expect((await prs.listPrs()).previews_on).toBe(true)
    expect(gh.fetchAuthoredPrs).toHaveBeenCalledTimes(1)
    dispose()
    expect((await prs.listPrs()).previews_on).toBe(false)
    expect(gh.fetchAuthoredPrs).toHaveBeenCalledTimes(1)
  })
})

describe('redeployPreview', () => {
  it('labels only open PRs Seti lists, in any repo', async () => {
    await expect(prs.redeployPreview('someone', 'else', 2)).rejects.toThrow('Not an open')
    await expect(prs.redeployPreview('globex', 'dashboard', 99)).rejects.toThrow('Not an open')
    expect(gh.addPreviewLabel).not.toHaveBeenCalled()
    expect(await prs.redeployPreview('GloBex', 'dashboard', 2)).toBe(false)
    expect(gh.addPreviewLabel).toHaveBeenCalledWith('globex/dashboard', 2)
    expect(await prs.redeployPreview('initech', 'billing', 7)).toBe(false)
    expect(gh.addPreviewLabel).toHaveBeenCalledWith('initech/billing', 7)
  })

  it('reports a re-added label and refetches the list on the next read', async () => {
    gh.addPreviewLabel.mockResolvedValue(true)
    expect(await prs.redeployPreview('globex', 'dashboard', 3)).toBe(true)
    await prs.listPrs()
    await vi.waitFor(() => {
      expect(gh.fetchAuthoredPrs).toHaveBeenCalledTimes(1)
    })
  })
})
