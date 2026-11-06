import { randomUUID } from 'node:crypto'
import type { Locator } from '@playwright/test'
import type { PullRequest, Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { openAgentPrs } from './support/phone-agent.js'
import { BURST, seedToolBurst } from './support/tool-groups.js'

const TARGET_PX = 44
const SLUG = 'e2e/touch'
const PR_URL = `https://github.com/${SLUG}/pull/7`

async function size(locator: Locator): Promise<{ width: number; height: number }> {
  const box = await locator.boundingBox()
  return { width: box?.width ?? 0, height: box?.height ?? 0 }
}

async function expectTall(locator: Locator, name: string): Promise<void> {
  expect((await size(locator)).height, name).toBeGreaterThanOrEqual(TARGET_PX)
}

async function seedTask(title: string, status: 'idle' | 'error' = 'idle'): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.run(`UPDATE task SET status = ? WHERE id = ?`, status, id)
  if (status === 'error') {
    await db.run(`UPDATE task SET unseen = true WHERE id = ?`, id)
  }
  await db.close()
  return id
}

const failingPr: PullRequest = {
  key: 'touch-7',
  repo_id: SLUG,
  repo_slug: SLUG,
  number: 7,
  title: 'touch change',
  url: PR_URL,
  draft: false,
  author: 'e2e',
  head_ref: 'feat/touch',
  base_ref: 'main',
  head_oid: 'abc1234',
  updated_at: '2026-10-03T10:00:00Z',
  review_decision: null,
  mergeable: 'mergeable',
  labels: [],
  ci: 'failure',
  checks: [{ name: 'build', state: 'failure', detail: 'failure', url: `${PR_URL}/checks` }],
  unresolved_threads: 0,
  preview: { state: 'none', url: null, commit: null, stale: false },
  preview_host: null,
  tasks: [],
  related: [],
}

test('tool group rows, the Monitor row and Send reach 44px', async ({ page }) => {
  const id = await seedToolBurst(unique('Touch burst'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  await expect(pane.getByText(BURST.outro)).toBeVisible()
  const burst = pane.getByTestId('tool-group').first()
  const header = burst.getByRole('button', { name: /Ran 10 commands/ })
  await expectTall(header, 'tool group header')
  await header.tap()
  await expectTall(burst.locator('summary').first(), 'tool call row')
  const monitor = pane.locator('summary').filter({ hasText: 'watching' })
  await expectTall(monitor, 'Monitor row')
  const send = page.getByRole('button', { name: 'Send', exact: true })
  const box = await size(send)
  expect(Math.min(box.width, box.height), 'Send').toBeGreaterThanOrEqual(TARGET_PX)
})

test('the Needs you header reaches 44px', async ({ page }) => {
  const title = unique('Touch failed')
  const id = await seedTask(title, 'error')
  await page.goto('/#agents')
  const header = page.getByRole('main').getByRole('region', { name: 'Needs you' }).getByRole('button').first()
  await expect(header).toBeVisible()
  await expectTall(header, 'Needs you header')
  await page.request.delete(`/api/tasks/${id}`)
})

test('linked PR rows reach 44px and an unlink can be undone', async ({ page, request }) => {
  const id = await seedTask(unique('Touch linked'))
  expect((await request.post(`/api/tasks/${id}/prs`, { data: { url: PR_URL } })).ok()).toBe(true)
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    await route.fulfill({ json: { data: [failingPr], meta: {} } })
  })
  await page.goto(`/#agents/${id}`)
  const sheet = await openAgentPrs(page)
  const row = sheet.getByRole('listitem', { name: 'Pull request touch#7' })
  const unlink = row.getByRole('button', { name: 'Unlink touch#7' })
  await expectTall(row, 'PR row')
  await expectTall(row.getByRole('button', { name: 'Fix CI' }), 'Fix CI')
  const box = await size(unlink)
  expect(Math.min(box.width, box.height), 'Unlink').toBeGreaterThanOrEqual(TARGET_PX)

  const linked = async () => (await apiData<Task>(request, `/tasks/${id}`)).pr_urls
  await unlink.tap()
  await expect.poll(linked).toEqual([])
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Unlinked touch#7' })
  const relinked = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith(`/tasks/${id}/prs`),
  )
  await toast.getByRole('button', { name: 'Undo' }).tap()
  expect((await relinked).ok()).toBe(true)
  await expect.poll(linked).toEqual([PR_URL])
  await request.delete(`/api/tasks/${id}`)
})

test('switches take a tap within 44px around them', async ({ page }) => {
  await page.goto('/#settings/sandbox')
  const toggle = page.getByRole('main').getByRole('switch', { name: 'Sandbox agents' })
  await expect(toggle).toBeVisible()
  const box = await toggle.boundingBox()
  if (box === null) {
    throw new Error('the switch has no box')
  }
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const points = [
    [cx, cy - TARGET_PX / 2 + 1],
    [cx, cy + TARGET_PX / 2 - 1],
    [cx - TARGET_PX / 2 + 1, cy],
    [cx + TARGET_PX / 2 - 1, cy],
  ]
  for (const [x, y] of points) {
    const hit = await page.evaluate(
      ([px, py]) => (document.elementFromPoint(px ?? 0, py ?? 0)?.closest('[role="switch"]') ?? null) !== null,
      [x, y],
    )
    expect(hit, `${String(x)},${String(y)}`).toBe(true)
  }
})
