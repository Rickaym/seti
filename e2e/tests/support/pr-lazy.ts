import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { PrList, PrRow, PullRequest } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { linkPrs, pr, prUrl } from './pr-ci.js'

export const LAZY = 'e2e/lazy'
export const LATE = prUrl('e2e/late', 4)
export const GONE = prUrl('e2e/late', 5)

/** A PR's detail as the lookup answers it, with two unresolved review threads. */
export const lazyDetail = (number: number): PullRequest => pr(LAZY, number, { unresolved_threads: 2 })

/** The slim row the list sends for a PR: what a row shows, and none of its detail. */
export function lazyRow(number: number): PrRow {
  const { key, repo_slug, title, url, draft, author, head_ref, base_ref, updated_at, review_decision, mergeable, ci } =
    lazyDetail(number)
  const row = { key, repo_slug, number, title, url, draft, author, head_ref, base_ref }
  return { ...row, updated_at, review_decision, mergeable, ci, tasks: [] }
}

export const lazyList = (count: number, over: Partial<PrList> = {}): PrList => ({
  viewer: 'e2e',
  prs: Array.from({ length: count }, (_, index) => lazyRow(index + 1)),
  error: null,
  more: 0,
  refreshing: false,
  previews_on: true,
  ...over,
})

/** An idle agent with the given PRs linked, so no agent ever runs. */
export async function seedIdleAgent(title: string, urls: readonly string[] = []): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  await linkPrs(id, urls)
  return id
}

/** Serves each list in turn to `GET /api/prs`, the last one from then on. */
export async function mockLists(page: Page, lists: readonly PrList[]): Promise<void> {
  let served = 0
  await page.route(/\/api\/prs$/, async (route) => {
    const list = lists[Math.min(served, lists.length - 1)]
    served += 1
    await route.fulfill({ json: { data: list, meta: {} } })
  })
}

/** Answers detail lookups for the lazy PRs and records the URLs each request asked for. */
export async function mockLazyDetails(page: Page): Promise<string[][]> {
  const asked: string[][] = []
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    const { urls } = route.request().postDataJSON() as { urls: string[] }
    asked.push(urls)
    const prs = urls.flatMap((url) => {
      const number = Number(url.split('/').at(-1))
      return url.includes(`/${LAZY}/`) ? [lazyDetail(number)] : []
    })
    await route.fulfill({ json: { data: { prs, pending: [] }, meta: {} } })
  })
  return asked
}

/**
 * Answers the first `slow` lookups with the late PR still pending, then with its status; the
 * other PR is never an open one. Returns how many lookups came.
 */
export async function mockLateStatus(page: Page, slow: number): Promise<{ count: number }> {
  const seen = { count: 0 }
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    seen.count += 1
    const { urls } = route.request().postDataJSON() as { urls: string[] }
    const ready = seen.count > slow && urls.includes(LATE)
    const data = {
      prs: ready ? [pr('e2e/late', 4, { title: 'Arrives late', ci: 'success' })] : [],
      pending: ready ? [] : urls.filter((url) => url === LATE),
    }
    await route.fulfill({ json: { data, meta: {} } })
  })
  return seen
}
