import type { Page } from '@playwright/test'
import type { PullRequest } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test, unique } from './support/fixtures.js'
import { edgesAtRest, expectFitsPhone } from './support/phone-layout.js'
import { SEEDS, seedTask } from './support/subtasks.js'

const TITLE = 'Upgrade the dashboard websocket reconnection logic to the exponential backoff helper'
const NARROWEST = { width: 360, height: 780 }
const TARGET_PX = 44
/** The terminal bar's 44px row and its rule, which the phone agent header shares. */
const HEADER_PX = 45
/** Characters of the title a phone must show before it truncates. */
const TITLE_CHARS = 12
const PR_URLS = [411, 412].map((n) => `https://github.com/e2e/dashboard/pull/${String(n)}`)

const failingPr = (url: string, index: number): PullRequest => ({
  key: `header-fit-${String(index)}`,
  repo_id: 'e2e/dashboard',
  repo_slug: 'e2e/dashboard',
  number: 411 + index,
  title: 'Backoff on reconnect',
  url,
  draft: false,
  author: 'e2e',
  head_ref: 'feat/backoff',
  base_ref: 'main',
  head_oid: 'abc1234',
  updated_at: '2026-10-28T10:00:00Z',
  review_decision: null,
  mergeable: 'mergeable',
  labels: [],
  ci: index === 0 ? 'failure' : 'pending',
  checks: [{ name: 'build', state: 'failure', detail: 'exit 1', url: null }],
  unresolved_threads: 3,
  preview: { state: 'ready', url: 'https://preview.example.com', commit: 'abc1234', stale: false },
  preview_host: null,
  tasks: [],
  related: [],
})

/** A running agent with every header extra: Bypass, pinned, subagents, three repos and two PRs. */
async function seedWorstCase(): Promise<string> {
  const id = await seedTask(TITLE, paths.checkout, SEEDS.fanOut())
  const db = openSeedDb()
  const at = new Date().toISOString()
  const bypass = new Date(Date.now() + 3_600_000).toISOString()
  await db.run(
    `UPDATE task SET status = 'running', pinned = true, worktree = 1, bypass_until = ?, status_line = ? WHERE id = ?`,
    bypass,
    'Waiting on CI for the backoff change',
    id,
  )
  for (const url of PR_URLS) {
    await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, id, url, at)
  }
  for (const [position, name] of ['dashboard-frontend', 'payments-gateway-service', 'infra'].entries()) {
    const slug = unique(`e2e/${name}`)
    await db.run(
      `INSERT INTO repo (id, slug, path, base_branch, created_at) VALUES (?, ?, ?, 'main', ?)`,
      slug,
      slug,
      paths.checkout,
      at,
    )
    await db.run(
      `INSERT INTO task_repo (task_id, repo_id, position, dir) VALUES (?, ?, ?, ?)`,
      id,
      slug,
      position,
      paths.checkout,
    )
  }
  await db.close()
  return id
}

/** Runs in the page: each visible header element that reaches past the viewport, clipped or not. */
function headerOverflow(): string[] {
  const width = document.documentElement.clientWidth
  const header = document.querySelector('[data-testid="agent-header"]')
  if (header === null) {
    return ['no agent header']
  }
  return Array.from(header.querySelectorAll('*'))
    .filter((el) => el.checkVisibility({ visibilityProperty: true }))
    .map((el) => ({ el, box: el.getBoundingClientRect() }))
    .filter(({ box }) => box.width >= 1 && (box.left < -0.5 || box.right > width + 0.5))
    .map(({ el, box }) => {
      const name = el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 30)
      return `<${el.tagName.toLowerCase()}> "${name}" at ${String(Math.round(box.left))}..${String(Math.round(box.right))}`
    })
}

/** How many title characters show before the ellipsis. */
const shownTitleChars = async (page: Page) =>
  page
    .getByTestId('agent-header')
    .getByRole('heading', { level: 2 })
    .evaluate((h) => Math.floor((h.clientWidth / h.scrollWidth) * h.textContent.length))

test('the busiest agent header keeps one 44px row on a 360px phone with its title and controls in reach', async ({
  page,
}) => {
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    await route.fulfill({ json: { data: PR_URLS.map(failingPr), meta: {} } })
  })
  await page.setViewportSize(NARROWEST)
  const id = await seedWorstCase()
  await page.goto(`/#agents/${id}`)
  const header = page.getByTestId('agent-header')
  await expect(header.getByRole('heading', { name: TITLE, level: 2 })).toBeVisible()
  await expect(header.getByRole('img', { name: 'running' })).toBeVisible()
  await expect(header.getByTestId('prs-button')).toBeVisible()
  expect(await page.evaluate(headerOverflow)).toEqual([])
  await expectFitsPhone(page, 'busiest agent header at 360px')
  expect((await edgesAtRest(page, header)).height).toBe(HEADER_PX)
  expect(await shownTitleChars(page)).toBeGreaterThanOrEqual(TITLE_CHARS)
  for (const name of ['Back to agents', 'Stop', 'Agent settings', 'More actions']) {
    const button = header.getByRole('button', { name, exact: true })
    await expect(button).toBeInViewport({ ratio: 1 })
    const box = await button.boundingBox()
    expect(Math.min(box?.width ?? 0, box?.height ?? 0), name).toBeGreaterThanOrEqual(TARGET_PX)
  }
})
