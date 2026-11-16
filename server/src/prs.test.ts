import type { Preview } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListedRow, ListedStatus, SearchPage } from './github-list.js'
import type { OpenPr } from './github.js'
import type * as Prs from './prs.js'

const gh = vi.hoisted(() => ({
  fetchRowPage: vi.fn<(after: string | null) => Promise<SearchPage<ListedRow>>>(),
  fetchStatusPage: vi.fn<(after: string | null) => Promise<SearchPage<ListedStatus>>>(),
  fetchPrDetails: vi.fn<(urls: readonly string[]) => Promise<Map<string, OpenPr | null>>>(),
  addPreviewLabel: vi.fn<(slug: string, number: number) => Promise<boolean>>(),
}))
const state = vi.hoisted(() => ({ linked: [] as string[], budget: true, stored: undefined as string | undefined }))

const SLUG = 'globex/dashboard'

vi.mock('./db.js', () => ({
  repos: { list: async () => Promise.resolve([]) },
  closeDatabase: async () => Promise.resolve(),
}))
vi.mock('./store/prs.js', () => ({
  tasksByPrUrl: async () =>
    Promise.resolve(new Map([['https://github.com/pr/1', [{ id: 't1', title: 'Fix it', status: 'idle' as const }]]])),
  linkedPrUrls: async () => Promise.resolve(state.linked),
}))
vi.mock('./store/pr-list.js', () => ({
  prListStore: {
    read: async () =>
      Promise.resolve(state.stored === undefined ? undefined : { payload: state.stored, fetched_at: '2026-09-26' }),
    write: async (payload: string) => {
      state.stored = payload
      return Promise.resolve()
    },
  },
}))
vi.mock('./github-cache.js', () => ({ canPollGithub: async () => Promise.resolve(state.budget) }))
vi.mock('./github-list.js', () => ({ fetchRowPage: gh.fetchRowPage, fetchStatusPage: gh.fetchStatusPage }))
vi.mock('./github.js', () => ({
  fetchPrDetails: gh.fetchPrDetails,
  addPreviewLabel: gh.addPreviewLabel,
  viewerLogin: async () => Promise.resolve('Octocat'),
}))

const NO_PREVIEW: Preview = { state: 'none', url: null, commit: null, stale: false }
const url = (number: number) => `https://github.com/pr/${String(number)}`

/** A PR with its detail, as the URL lookup reads it. */
function detail(number: number, author = 'octocat', slug = SLUG): OpenPr {
  return {
    key: `${slug.split('/').at(-1) ?? slug}-${String(number)}`,
    repo_slug: slug,
    number,
    title: `PR ${String(number)}`,
    url: url(number),
    draft: false,
    author,
    head_ref: slug === SLUG ? 'feat/x' : `feat/${String(number)}`,
    base_ref: 'staging-eu',
    head_oid: 'abc1234',
    updated_at: `2026-09-26T00:${String(59 - (number % 60)).padStart(2, '0')}:00Z`,
    review_decision: null,
    mergeable: 'unknown',
    labels: ['bug'],
    ci: 'failure',
    checks: [{ name: 'build', state: 'failure', detail: 'failure', url: null }],
    unresolved_threads: 2,
    preview: NO_PREVIEW,
    preview_host: null,
    refs: [],
    body: 'The body',
  }
}

function row(number: number): ListedRow {
  const { key, repo_slug, title, draft, author, head_ref, base_ref, updated_at } = detail(number)
  return { key, repo_slug, number, title, url: url(number), draft, author, head_ref, base_ref, updated_at }
}

const status = (number: number): ListedStatus => ({
  url: url(number),
  review_decision: 'approved',
  mergeable: 'mergeable',
  ci: 'success',
})

const ROWS = [1, 2, 3]
/** A PR an agent linked that someone else wrote, in a repo Seti has no checkout of. */
const LINKED = detail(7, 'someone', 'initech/billing')

const rows = (numbers: readonly number[], total = numbers.length, next: string | null = null) => ({
  items: numbers.map(row),
  total,
  next,
})
const statuses = (numbers: readonly number[], next: string | null = null) => ({
  items: numbers.map(status),
  total: numbers.length,
  next,
})

/** Answers a detail lookup with every URL it knows as open and the rest as null. */
const answer =
  (open: readonly OpenPr[]) =>
  async (urls: readonly string[]): Promise<Map<string, OpenPr | null>> =>
    Promise.resolve(new Map(urls.map((asked) => [asked, open.find((pr) => pr.url === asked) ?? null])))

let clock = 1_000_000

/** A fresh module holds no cached list or detail, as after a restart. */
async function freshProcess() {
  vi.resetModules()
  return import('./prs.js')
}

let prs: typeof Prs

const numbers = (list: { prs: { number: number }[] }) => list.prs.map((p) => p.number)
const settled = async () => vi.waitFor(() => undefined, { timeout: 100 })

beforeEach(async () => {
  clock += 10 * 60_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  state.linked = [url(1), LINKED.url]
  state.budget = true
  state.stored = undefined
  gh.fetchRowPage.mockReset().mockResolvedValue(rows(ROWS, 5))
  gh.fetchStatusPage.mockReset().mockResolvedValue(statuses(ROWS))
  gh.fetchPrDetails.mockReset().mockImplementation(answer([detail(1), detail(2), detail(3), LINKED]))
  gh.addPreviewLabel.mockReset().mockResolvedValue(false)
  prs = await freshProcess()
})

/** Reads the list and waits for the detail of the linked PRs it fetches ahead. */
async function warmed(): Promise<void> {
  await prs.lookupPrs([url(1), LINKED.url])
  gh.fetchRowPage.mockClear()
  gh.fetchStatusPage.mockClear()
  gh.fetchPrDetails.mockClear()
}

describe('listPrs', () => {
  it('lists slim rows from two light searches and reads detail only for linked PRs', async () => {
    await warmed()
    const list = await prs.listPrs()
    expect(numbers(list)).toEqual([1, 2, 3, 7])
    expect(list).toMatchObject({ viewer: 'Octocat', error: null, more: 2, refreshing: false })
    expect(list.prs[0]).toEqual({
      ...row(1),
      review_decision: null,
      mergeable: 'unknown',
      ci: 'failure',
      tasks: [{ id: 't1', title: 'Fix it', status: 'idle' }],
    })
    expect(list.prs[1]).toMatchObject({ ci: 'success', review_decision: 'approved', mergeable: 'mergeable' })
    expect(list.prs[3]).toMatchObject({ repo_slug: 'initech/billing', author: 'someone' })
    state.stored = undefined
    prs = await freshProcess()
    await prs.lookupPrs([url(1), LINKED.url])
    expect(gh.fetchRowPage).toHaveBeenCalledTimes(1)
    expect(gh.fetchStatusPage).toHaveBeenCalledTimes(1)
    expect(gh.fetchPrDetails.mock.calls).toEqual([[[url(1), LINKED.url]]])
  })

  it('answers with the rows before their status arrives when no list exists yet', async () => {
    const release: ((page: SearchPage<ListedStatus>) => void)[] = []
    gh.fetchStatusPage.mockReturnValue(new Promise((resolve) => release.push(resolve)))
    const early = await prs.listPrs()
    expect(early.prs.filter((pr) => pr.number !== 1).map((pr) => pr.ci)).toEqual([null, null])
    expect(early.refreshing).toBe(true)
    release[0]?.(statuses(ROWS))
    await vi.waitFor(async () => {
      expect((await prs.listPrs()).prs[1]).toMatchObject({ number: 2, ci: 'success' })
    })
    expect((await prs.listPrs()).refreshing).toBe(false)
  })

  it('serves a stale list, marked refreshing, while one call reads a newer one', async () => {
    await warmed()
    clock += 61_000
    gh.fetchRowPage.mockResolvedValue(rows([9]))
    gh.fetchStatusPage.mockResolvedValue(statuses([9]))
    const [first, second] = await Promise.all([prs.listPrs(), prs.listPrs()])
    expect(numbers(first)).toEqual([1, 2, 3, 7])
    expect(first.refreshing).toBe(true)
    expect(numbers(second)).toEqual([1, 2, 3, 7])
    await vi.waitFor(async () => {
      expect(numbers(await prs.listPrs())).toEqual([1, 7, 9])
    })
    expect(gh.fetchRowPage).toHaveBeenCalledTimes(1)
  })

  it('shows the list the database kept at once after a restart, then the fresh one', async () => {
    await warmed()
    expect(state.stored).toContain('"v":1')
    clock += 3 * 60 * 60_000
    gh.fetchRowPage.mockResolvedValue(rows([4]))
    gh.fetchStatusPage.mockResolvedValue(statuses([4]))
    prs = await freshProcess()
    const kept = await prs.listPrs()
    expect(numbers(kept)).toEqual([1, 2, 3])
    expect(kept.refreshing).toBe(true)
    await vi.waitFor(async () => {
      expect(numbers(await prs.listPrs())).toContain(4)
    })
    state.stored = '{"v":0,"prs":"old shape"}'
    gh.fetchRowPage.mockClear()
    expect(numbers(await (await freshProcess()).listPrs())).toContain(4)
    expect(gh.fetchRowPage).toHaveBeenCalledTimes(1)
  })

  it('reports the gh error when nothing is cached, and still lists linked PRs it has detail for', async () => {
    gh.fetchRowPage.mockRejectedValue(new Error('gh: not logged in'))
    const list = await prs.listPrs()
    expect(list).toMatchObject({ error: 'gh: not logged in', more: 0 })
    await vi.waitFor(async () => {
      expect(numbers(await prs.listPrs())).toEqual([1, 7])
    })
    expect(gh.fetchRowPage).toHaveBeenCalledTimes(1)
  })
})

describe('paging', () => {
  const page = (after: string | null) => (after === null ? 1 : Number(after.split('-')[1]) + 1)

  beforeEach(() => {
    state.linked = []
    gh.fetchRowPage.mockImplementation(async (after) =>
      Promise.resolve(rows([100 + page(after)], 9, `cursor-${String(page(after))}`)),
    )
    gh.fetchStatusPage.mockImplementation(async (after) =>
      Promise.resolve(statuses([100 + page(after)], `cursor-${String(page(after))}`)),
    )
  })

  it('follows the cursors of both searches and stops at two pages, counting what is left', async () => {
    await prs.lookupPrs([])
    const list = await vi.waitFor(async () => {
      const read = await prs.listPrs()
      expect(read.refreshing).toBe(false)
      return read
    })
    expect(list).toMatchObject({
      more: 7,
      prs: [
        { number: 101, ci: 'success' },
        { number: 102, ci: 'success' },
      ],
    })
    expect(gh.fetchRowPage.mock.calls.map(([after]) => after)).toEqual([null, 'cursor-1'])
    expect(gh.fetchStatusPage.mock.calls.map(([after]) => after)).toEqual([null, 'cursor-1'])
  })

  it('reads only the first page while the GitHub budget is low', async () => {
    state.budget = false
    await prs.lookupPrs([])
    await vi.waitFor(async () => {
      expect(await prs.listPrs()).toMatchObject({ more: 8, refreshing: false, prs: [{ number: 101 }] })
    })
    expect(gh.fetchRowPage).toHaveBeenCalledTimes(1)
  })
})

describe('lookupPrs', () => {
  it('reads the detail of the rows asked for in one query, then answers from its cache', async () => {
    await warmed()
    const found = await prs.lookupPrs([url(2), url(3), 'https://example.test/x/pull/1'])
    expect(found.pending).toEqual([])
    expect(found.prs.map((pr) => pr.number)).toEqual([2, 3])
    expect(found.prs[0]).toMatchObject({ checks: [{ name: 'build' }], unresolved_threads: 2, labels: ['bug'] })
    expect(found.prs[0]).not.toHaveProperty('refs')
    expect(found.prs[0]).not.toHaveProperty('body')
    expect(found.prs[0]?.related.map((r) => r.key)).toEqual(['dashboard-1', 'dashboard-3'])
    expect(gh.fetchPrDetails.mock.calls).toEqual([[[url(2), url(3)]]])
    await prs.lookupPrs([url(1), url(2), url(3), LINKED.url])
    expect(gh.fetchPrDetails).toHaveBeenCalledTimes(1)
    expect(gh.fetchRowPage).not.toHaveBeenCalled()
  })

  it('reports a URL GitHub has not answered as pending, and its detail once it arrived', async () => {
    await warmed()
    let release: () => void = () => undefined
    gh.fetchPrDetails.mockImplementation(async (urls) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return answer([detail(2)])(urls)
    })
    const early = await prs.lookupPrs([url(1), url(2)], 30)
    expect(early.prs.map((pr) => pr.number)).toEqual([1])
    expect(early.pending).toEqual([url(2)])
    await vi.waitFor(() => {
      expect(gh.fetchPrDetails).toHaveBeenCalledTimes(1)
    })
    release()
    await vi.waitFor(async () => {
      expect(await prs.lookupPrs([url(2)], 30)).toMatchObject({ prs: [{ number: 2 }], pending: [] })
    })
    expect(gh.fetchPrDetails).toHaveBeenCalledTimes(1)
  })

  it('reads a PR linked after the list was read, with no new list', async () => {
    await warmed()
    const fresh = detail(8, 'someone', 'initech/billing')
    state.linked = [...state.linked, fresh.url]
    gh.fetchPrDetails.mockImplementation(answer([fresh]))
    expect((await prs.lookupPrs([fresh.url])).prs.map((pr) => pr.key)).toEqual(['billing-8'])
    expect(gh.fetchRowPage).not.toHaveBeenCalled()
  })

  it('answers no status for a PR GitHub does not show as open, and for one gh failed on', async () => {
    await warmed()
    state.linked = [...state.linked, url(99)]
    expect(await prs.lookupPrs([url(99)])).toEqual({ prs: [], pending: [] })
    gh.fetchPrDetails.mockRejectedValue(new Error('gh: timeout'))
    expect(await prs.lookupPrs([url(2)])).toEqual({ prs: [], pending: [] })
    gh.fetchPrDetails.mockClear().mockImplementation(answer([detail(2)]))
    clock += 11_000
    await prs.lookupPrs([url(2)])
    await vi.waitFor(async () => {
      expect((await prs.lookupPrs([url(2)])).prs.map((pr) => pr.number)).toEqual([2])
    })
  })

  it('serves stale detail while it is read again, and asks in batches of 20', async () => {
    const many = Array.from({ length: 45 }, (_, n) => 100 + n)
    gh.fetchRowPage.mockResolvedValue(rows(many))
    gh.fetchStatusPage.mockResolvedValue(statuses(many))
    gh.fetchPrDetails.mockImplementation(answer(many.map((n) => detail(n))))
    state.linked = []
    expect((await prs.lookupPrs(many.map(url))).prs).toHaveLength(45)
    expect(gh.fetchPrDetails.mock.calls.map(([urls]) => urls.length)).toEqual([20, 20, 5])
    clock += 61_000
    gh.fetchPrDetails.mockClear().mockImplementation(answer([{ ...detail(100), title: 'Renamed' }]))
    expect((await prs.lookupPrs([url(100)])).prs[0]?.title).toBe('PR 100')
    await vi.waitFor(async () => {
      expect((await prs.lookupPrs([url(100)])).prs[0]?.title).toBe('Renamed')
    })
    expect(gh.fetchPrDetails).toHaveBeenCalledTimes(1)
  })

  it('reads a PR again once the poller saw it change', async () => {
    await warmed()
    await prs.prChanged(url(1))
    gh.fetchPrDetails.mockImplementation(answer([{ ...detail(1), ci: 'success', checks: [] }]))
    await vi.waitFor(async () => {
      expect((await prs.lookupPrs([url(1)])).prs[0]?.ci).toBe('success')
    })
  })
})

describe('findPr', () => {
  it('reads an open PR that is neither listed nor linked straight from GitHub', async () => {
    await warmed()
    const stray = detail(11, 'someone', 'umbrella/tools')
    gh.fetchPrDetails.mockImplementation(answer([stray]))
    expect(await prs.findPr(stray.url)).toMatchObject({ key: 'tools-11', tasks: [], related: [] })
    expect(await prs.findPr(url(12))).toBeNull()
    expect(gh.fetchRowPage).not.toHaveBeenCalled()
  })
})

describe('PR decorators', () => {
  it('reads detail again when the decorators change, and says whether previews are on', async () => {
    await warmed()
    const { prDecorators } = await import('./pr-decorators.js')
    expect((await prs.listPrs()).previews_on).toBe(false)
    const dispose = prDecorators.register({ key: 'test.preview', decorate: () => ({}) })
    expect((await prs.listPrs()).previews_on).toBe(true)
    await prs.lookupPrs([url(1)])
    expect(gh.fetchPrDetails).toHaveBeenCalled()
    expect(gh.fetchRowPage).not.toHaveBeenCalled()
    dispose()
  })
})

describe('cachedOpenPrs', () => {
  it('gives every known PR, with the detail read so far and none for the rest', async () => {
    await warmed()
    const open = await prs.cachedOpenPrs()
    expect(open.map((pr) => [pr.number, pr.unresolved_threads, pr.body])).toEqual([
      [1, 2, 'The body'],
      [2, 0, undefined],
      [3, 0, undefined],
      [7, 2, 'The body'],
    ])
  })

  it('tells its listeners about each batch of detail and each list read', async () => {
    const heard: number[][] = []
    prs.onOpenPrsFetched((batch) => heard.push(batch.map((pr) => pr.number)))
    await prs.lookupPrs([url(1), LINKED.url])
    await settled()
    expect(heard.toSorted((a, b) => a.length - b.length)).toEqual([[], [1, 7]])
  })
})

describe('redeployPreview', () => {
  it('labels only open PRs Seti lists, in any repo, and reads their detail again', async () => {
    await warmed()
    await expect(prs.redeployPreview('someone', 'else', 2)).rejects.toThrow('Not an open')
    await expect(prs.redeployPreview('globex', 'dashboard', 99)).rejects.toThrow('Not an open')
    expect(gh.addPreviewLabel).not.toHaveBeenCalled()
    expect(await prs.redeployPreview('GloBex', 'dashboard', 2)).toBe(false)
    expect(gh.addPreviewLabel).toHaveBeenCalledWith('globex/dashboard', 2)
    gh.addPreviewLabel.mockResolvedValue(true)
    expect(await prs.redeployPreview('initech', 'billing', 7)).toBe(true)
    await prs.lookupPrs([LINKED.url])
    await vi.waitFor(() => {
      expect(gh.fetchPrDetails.mock.calls).toEqual([[[LINKED.url]]])
    })
  })
})
