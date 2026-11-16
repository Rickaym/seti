import type { Preview } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthoredPage, OpenPr } from './github.js'
import type * as Prs from './prs.js'

const gh = vi.hoisted(() => ({
  fetchAuthoredPage: vi.fn<(after: string | null) => Promise<AuthoredPage>>(),
  fetchOpenPrsByUrl: vi.fn<(urls: readonly string[]) => Promise<OpenPr[]>>(),
  addPreviewLabel: vi.fn<(slug: string, number: number) => Promise<boolean>>(),
}))
const linked = vi.hoisted(() => ({ urls: [] as string[] }))
const budget = vi.hoisted(() => ({ ok: true }))

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
vi.mock('./github-cache.js', () => ({ canPollGithub: async () => Promise.resolve(budget.ok) }))
vi.mock('./github.js', () => ({
  fetchAuthoredPage: gh.fetchAuthoredPage,
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
    updated_at: `2026-09-26T00:${String(59 - (number % 60)).padStart(2, '0')}:00Z`,
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
  budget.ok = true
  gh.fetchAuthoredPage.mockReset().mockResolvedValue({ prs: PRS, total: 5, next: null })
  gh.fetchOpenPrsByUrl
    .mockReset()
    .mockImplementation(async (urls) => Promise.resolve([LINKED].filter((open) => urls.includes(open.url))))
  gh.addPreviewLabel.mockReset().mockResolvedValue(false)
  prs = await freshProcess()
  await prs.listPrs()
  gh.fetchAuthoredPage.mockClear()
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
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)
    expect(gh.fetchOpenPrsByUrl.mock.calls).toEqual([[[LINKED.url]]])
  })

  it('serves a stale list while one shared call refreshes it', async () => {
    clock += 61_000
    gh.fetchAuthoredPage.mockResolvedValue({ prs: [pr(9, 'Octocat')], total: 1, next: null })
    const [first, second] = await Promise.all([prs.listPrs(), prs.listPrs()])
    expect(first.prs).toHaveLength(4)
    expect(second.prs).toHaveLength(4)
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)
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
    gh.fetchAuthoredPage.mockRejectedValue(new Error('gh: not logged in'))
    const list = await (await freshProcess()).listPrs()
    expect(list).toMatchObject({ error: 'gh: not logged in', prs: [], more: 0 })
  })
})

describe('paging', () => {
  const page = (n: number): AuthoredPage => ({
    prs: [pr(100 + n, 'octocat', NO_PREVIEW, 'umbrella/pages')],
    total: 9,
    next: `cursor-${String(n)}`,
  })

  beforeEach(() => {
    linked.urls = []
    gh.fetchAuthoredPage.mockImplementation(async (after) =>
      Promise.resolve(page(after === null ? 1 : Number(after.split('-')[1]) + 1)),
    )
  })

  it('follows the cursors and stops at four pages, counting what is left', async () => {
    prs = await freshProcess()
    const list = await prs.listPrs()
    await vi.waitFor(() => {
      expect(gh.fetchAuthoredPage.mock.calls.map(([after]) => after)).toEqual([
        null,
        'cursor-1',
        'cursor-2',
        'cursor-3',
      ])
    })
    expect(numbers(list)).toEqual([101])
    const full = await vi.waitFor(async () => {
      const read = await prs.listPrs()
      expect(numbers(read)).toEqual([101, 102, 103, 104])
      return read
    })
    expect(full.more).toBe(5)
  })

  it('stops when the last page has no next cursor', async () => {
    gh.fetchAuthoredPage.mockImplementation(async (after) =>
      Promise.resolve(after === null ? { ...page(1), total: 2 } : { ...page(2), total: 2, next: null }),
    )
    prs = await freshProcess()
    expect((await prs.lookupPrs([page(2).prs[0]?.url ?? ''])).map((p) => p.number)).toEqual([102])
    expect((await prs.listPrs()).more).toBe(0)
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(2)
  })

  it('reads only the first page while the GitHub budget is low', async () => {
    budget.ok = false
    prs = await freshProcess()
    await prs.lookupPrs([])
    await vi.waitFor(async () => {
      expect(await prs.listPrs()).toMatchObject({ more: 8, prs: [{ number: 101 }] })
    })
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)
  })

  it('gives a status lookup the whole list, never only the first page', async () => {
    prs = await freshProcess()
    const last = `https://github.com/pr/104`
    expect((await prs.lookupPrs([last])).map((p) => p.number)).toEqual([104])
  })
})

describe('lookupPrs', () => {
  it('resolves many URLs from one cached list, leaving out closed or unknown ones', async () => {
    const unknown = Array.from({ length: 200 }, (_, n) => `https://example.test/x/pull/${String(n)}`)
    const found = await prs.lookupPrs([...PRS.map((p) => p.url), LINKED.url, ...unknown])
    expect(found.map((p) => p.number)).toEqual([1, 2, 3, 7])
    expect(found[0]?.tasks).toEqual([{ id: 't1', title: 'Fix it', status: 'idle' }])
    expect(found[0]).not.toHaveProperty('refs')
    expect(gh.fetchAuthoredPage).not.toHaveBeenCalled()
    expect(await prs.lookupPrs([])).toEqual([])
  })

  it('asks GitHub again for a PR linked after the list was read, once', async () => {
    const fresh = pr(8, 'someone', NO_PREVIEW, 'initech/billing')
    linked.urls = [...linked.urls, fresh.url]
    gh.fetchOpenPrsByUrl.mockResolvedValue([LINKED, fresh])
    expect((await prs.lookupPrs([fresh.url])).map((p) => p.key)).toEqual(['billing-8'])
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)
    await prs.lookupPrs([fresh.url])
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)
  })

  it('does not ask again for a linked PR that GitHub does not show as open', async () => {
    const gone = 'https://github.com/initech/billing/pull/99'
    linked.urls = [...linked.urls, gone]
    expect(await prs.lookupPrs([gone])).toEqual([])
    expect(await prs.lookupPrs([gone])).toEqual([])
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)
  })
})

describe('findPr', () => {
  it('reads an open PR that is neither listed nor linked straight from GitHub', async () => {
    const stray = pr(11, 'someone', NO_PREVIEW, 'umbrella/tools')
    gh.fetchOpenPrsByUrl.mockResolvedValue([stray])
    expect(await prs.findPr(stray.url)).toMatchObject({ key: 'tools-11', tasks: [], related: [] })
    expect(gh.fetchAuthoredPage).not.toHaveBeenCalled()
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
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)
    dispose()
    expect((await prs.listPrs()).previews_on).toBe(false)
    expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)
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
      expect(gh.fetchAuthoredPage).toHaveBeenCalledTimes(1)
    })
  })
})
