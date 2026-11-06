import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { AuditPage, LinkedPrState, Task } from '@seti/shared'
import { openSeedDb, type SeedValue } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'

const API_PR = 'https://github.com/e2e/api/pull/5'
const WEB_PR = 'https://github.com/e2e/web/pull/9'

/** Writes an idle task straight into the server's database, so no agent ever runs. */
async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  await db.close()
  return id
}

async function linkByUrl(page: Page, url: string): Promise<void> {
  await page.getByRole('main').getByRole('button', { name: 'Link PR' }).click()
  const picker = page.getByRole('dialog')
  await picker.getByLabel('Pull request URL').fill(url)
  await picker.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(picker).toBeHidden()
}

test('links two pull requests from different repos to one task and unlinks one', async ({ page, request }) => {
  const id = await seedTask('E2E two PRs')
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'E2E two PRs' })).toBeVisible()

  await linkByUrl(page, API_PR)
  await linkByUrl(page, WEB_PR)
  const api = main.getByRole('group', { name: 'Pull request api#5' })
  const web = main.getByRole('group', { name: 'Pull request web#9' })
  await expect(api.getByRole('link', { name: 'api#5' })).toHaveAttribute(
    'title',
    'Not open, or not in a registered repo',
  )
  await expect(web).toBeVisible()
  await expect(web.getByRole('link', { name: 'web#9' })).toHaveAttribute('href', WEB_PR)
  const listItem = page.locator(`[data-task-id="${id}"]`)
  await expect(listItem).toBeVisible()
  await expect(listItem).not.toContainText('#')
  const linked = async () => (await apiData<Task>(request, `/tasks/${id}`)).pr_urls
  await expect.poll(linked).toEqual([API_PR, WEB_PR])

  await api.getByRole('button', { name: 'Unlink api#5' }).click()
  await expect(api).toBeHidden()
  await expect(web).toBeVisible()
  await expect.poll(linked).toEqual([WEB_PR])

  const audited = async () =>
    (await apiData<AuditPage>(request, `/audit?kind=task&q=${id}&limit=10`)).events.map((e) => [e.kind, e.summary])
  await expect.poll(audited).toEqual([
    ['task.pr_unlinked', 'Unlinked PR e2e/api#5'],
    ['task.pr_linked', 'Linked PR e2e/web#9'],
    ['task.pr_linked', 'Linked PR e2e/api#5'],
  ])
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})

test('folds a long PR list into a list that opens over the header', async ({ page }) => {
  const id = await seedTask('E2E many PRs')
  const db = openSeedDb()
  const link = async (...values: SeedValue[]) =>
    db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, ...values)
  for (let n = 1; n <= 7; n += 1) {
    await link(id, `https://github.com/e2e/many/pull/${String(n)}`, `2026-01-01T00:00:0${String(n)}Z`)
  }
  await db.close()
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const groups = main.getByRole('group', { name: /^Pull request many#/ })
  await expect(groups).toHaveCount(4)
  await main.getByRole('button', { name: '+3 more' }).click()
  const list = page.getByRole('dialog', { name: 'Linked PRs (7)' })
  await expect(list.getByRole('listitem')).toHaveCount(7)
  const first = list.getByRole('listitem').first()
  await expect(first).toHaveAccessibleName('Pull request many#7')
  await expect(first).toContainText('e2e/many#7')
  expect((await first.innerText()).match(/many/g)).toHaveLength(1)
  await expect(groups).toHaveCount(4)
})

test('brings PRs still in flight in front of merged ones', async ({ page }) => {
  const id = await seedTask('E2E mixed PRs')
  const db = openSeedDb()
  const link = async (...values: SeedValue[]) =>
    db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, ...values)
  const watch = async (...values: SeedValue[]) =>
    db.run(`INSERT INTO pr_watch (pr_url, snapshot, open, checked_at) VALUES (?, ?, ?, ?)`, ...values)
  const ts = new Date().toISOString()
  for (let n = 1; n <= 6; n += 1) {
    const url = `https://github.com/e2e/mixed/pull/${String(n)}`
    await link(id, url, `2026-01-01T00:00:0${String(n)}Z`)
    const state: LinkedPrState = n <= 4 ? 'merged' : 'open'
    const snapshot = { state, conflicting: false, ci: null, review_ids: [], comment_ids: [] }
    await watch(url, JSON.stringify(snapshot), state === 'open' ? 1 : 0, ts)
  }
  await db.close()
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const groups = main.getByRole('group', { name: /^Pull request mixed#/ })
  await expect(groups).toHaveCount(4)
  await expect(groups.nth(0)).toHaveAccessibleName('Pull request mixed#6')
  await expect(groups.nth(1)).toHaveAccessibleName('Pull request mixed#5')
  await expect(main.getByRole('button', { name: /E2E mixed PRs/ })).not.toContainText('mixed#')
})

test('shows complete for an idle task once its linked PRs are merged or closed', async ({ page }) => {
  const done = await seedTask('E2E landed PRs')
  const waiting = await seedTask('E2E open PR')
  const db = openSeedDb()
  const link = async (...values: SeedValue[]) =>
    db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, ...values)
  const watch = async (...values: SeedValue[]) =>
    db.run(`INSERT INTO pr_watch (pr_url, snapshot, open, checked_at) VALUES (?, ?, ?, ?)`, ...values)
  const ts = new Date().toISOString()
  const prs: [string, string, LinkedPrState][] = [
    [done, 'https://github.com/e2e/landed/pull/1', 'merged'],
    [done, 'https://github.com/e2e/landed/pull/2', 'closed'],
    [waiting, 'https://github.com/e2e/landed/pull/3', 'open'],
  ]
  for (const [task, url, state] of prs) {
    await link(task, url, ts)
    const snapshot = { state, conflicting: false, ci: null, review_ids: [], comment_ids: [] }
    await watch(url, JSON.stringify(snapshot), state === 'open' ? 1 : 0, ts)
  }
  await db.close()

  await page.goto(`/#agents/${done}`)
  const main = page.getByRole('main')
  const header = main.getByRole('heading', { name: 'E2E landed PRs' }).locator('..')
  await expect(header.getByText('complete', { exact: true })).toBeVisible()
  await expect(
    main.getByRole('button', { name: /E2E landed PRs/ }).getByRole('img', { name: 'complete' }),
  ).toBeVisible()
  await expect(main.getByRole('button', { name: /E2E open PR/ }).getByRole('img', { name: 'idle' })).toBeVisible()
})

test('the PR chip row holds one count at every width, with no flicker at the boundaries', async ({ page }) => {
  const id = await seedTask('E2E PR row widths')
  const db = openSeedDb()
  for (const n of [1618, 1619]) {
    await db.run(
      `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`,
      id,
      `https://github.com/e2e/voice-bot/pull/${String(n)}`,
      new Date().toISOString(),
    )
  }
  await db.close()
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('group', { name: /^Pull request voice-bot#/ })).toHaveCount(2)

  const steps = await page.evaluate(async () => {
    const chips = () => document.querySelectorAll('main [role="group"][aria-label^="Pull request "]:not([inert] *)')
    const line = chips()[0]?.parentElement?.parentElement?.parentElement
    if (!line) {
      return []
    }
    const frame = async () => new Promise((resolve) => requestAnimationFrame(resolve))
    const watch = async (width: number, frames: number) => {
      line.style.width = `${String(width)}px`
      const counts: number[] = []
      for (let n = 0; n < frames; n += 1) {
        await frame()
        counts.push(chips().length)
      }
      return { width, counts: counts.slice(2) }
    }
    const coarse: { width: number; counts: number[] }[] = []
    for (let width = 1200; width >= 160; width -= 8) {
      coarse.push(await watch(width, 4))
    }
    const fine: { width: number; counts: number[] }[] = []
    for (const [index, step] of coarse.entries()) {
      const next = coarse[index + 1]
      if (next !== undefined && next.counts.at(-1) !== step.counts.at(-1)) {
        for (let width = step.width; width >= next.width; width -= 1) {
          fine.push(await watch(width, 12))
        }
      }
    }
    return [...coarse, ...fine]
  })
  expect([...new Set(steps.flatMap((step) => step.counts))].toSorted((a, b) => a - b)).toEqual([0, 1, 2])
  expect(steps.filter((step) => new Set(step.counts).size > 1)).toEqual([])
  expect((await page.request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
