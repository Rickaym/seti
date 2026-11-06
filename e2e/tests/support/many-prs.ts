import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { Envelope, LinkedPrState, PullRequest, Task } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { apiData, expect, unique } from './fixtures.js'

export const MANY_PRS = 150
const SLUG = 'e2e/many'
/** The linked PR whose title the search finds, and which the list unlinks. */
export const LOGIN_PR = 120

const manyPrUrl = (n: number) => `https://github.com/${SLUG}/pull/${String(n)}`

/** Merged up to 60, closed to 80, open after; #150 fails CI, #149 conflicts, #148 is a draft. */
const stateOf = (n: number): LinkedPrState => {
  if (n <= 60) {
    return 'merged'
  }
  return n <= 80 ? 'closed' : 'open'
}

/** Unresolved review threads: three on #150, one on #147, none elsewhere. */
const THREADS = new Map([
  [MANY_PRS, 3],
  [MANY_PRS - 3, 1],
])

function openPr(n: number): PullRequest {
  return {
    key: `many-${String(n)}`,
    repo_id: SLUG,
    repo_slug: SLUG,
    number: n,
    title: n === LOGIN_PR ? 'Fix login redirect' : `Many change ${String(n)}`,
    url: manyPrUrl(n),
    draft: n === MANY_PRS - 2,
    author: 'e2e',
    head_ref: `feat/many-${String(n)}`,
    base_ref: 'main',
    head_oid: 'abc1234def',
    updated_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    review_decision: null,
    mergeable: n === MANY_PRS - 1 ? 'conflicting' : 'mergeable',
    labels: [],
    ci: n === MANY_PRS ? 'failure' : 'success',
    checks: [],
    unresolved_threads: THREADS.get(n) ?? 0,
    preview: { state: 'none', url: null, commit: null, stale: false },
    preview_host: null,
    tasks: [],
    related: [],
  }
}

/** Answers the batched status lookup with every open PR of the fixture, as GitHub would. */
export async function mockManyStatuses(page: Page, count = MANY_PRS): Promise<void> {
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    const asked = new Set((route.request().postDataJSON() as { urls: string[] }).urls)
    const prs = Array.from({ length: count }, (_, i) => i + 1)
      .filter((n) => stateOf(n) === 'open')
      .map(openPr)
      .filter((pr) => asked.has(pr.url))
    await route.fulfill({ json: { data: prs, meta: {} } })
  })
}

/** Links `count` PRs to the task in the database, with their last polled states. */
export async function linkManyPrs(taskId: string, count = MANY_PRS): Promise<void> {
  const db = openSeedDb()
  const at = new Date().toISOString()
  for (let n = 1; n <= count; n += 1) {
    const url = manyPrUrl(n)
    const state = stateOf(n)
    const linkedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
    await db.run(
      `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`,
      taskId,
      url,
      linkedAt,
    )
    const snapshot = { state, conflicting: false, ci: null, review_ids: [], comment_ids: [] }
    await db.run(
      `INSERT INTO pr_watch (pr_url, snapshot, open, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (pr_url) DO NOTHING`,
      url,
      JSON.stringify(snapshot),
      state === 'open' ? 1 : 0,
      at,
    )
  }
  await db.close()
}

/** Starts an agent on the fake Claude Code and waits for its first turn to end. */
export async function startAgent(request: APIRequestContext, label: string): Promise<{ id: string; title: string }> {
  const title = unique(label)
  const response = await request.post('/api/tasks', {
    data: { title, prompt: `Please greet as ${title}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  return { id, title }
}

export const linkedCount = async (request: APIRequestContext, id: string) =>
  (await apiData<Task>(request, `/tasks/${id}`)).pr_urls.length

export async function boxOf(locator: Locator) {
  const found = await locator.boundingBox()
  expect(found, 'bounding box').not.toBeNull()
  return found ?? { x: 0, y: 0, width: 0, height: 0 }
}
