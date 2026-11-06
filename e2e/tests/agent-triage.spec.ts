import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { needsYou as needsYouStatus, type TaskStatus } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const PREFIX = `Triage ${randomUUID().slice(0, 6)}`

interface Seed {
  name: string
  status: TaskStatus
  minutesAgo: number
  pinned?: boolean
}

const SEEDS: Seed[] = [
  { name: 'pinned idle', status: 'idle', minutesAgo: 1, pinned: true },
  { name: 'old error', status: 'error', minutesAgo: 50 },
  { name: 'running', status: 'running', minutesAgo: 5 },
  { name: 'cut off', status: 'interrupted', minutesAgo: 20 },
  { name: 'stopped', status: 'stopped', minutesAgo: 10 },
  { name: 'fresh error', status: 'error', minutesAgo: 2 },
]

const title = (seed: Pick<Seed, 'name'>) => `${PREFIX} ${seed.name}`

test.beforeAll(async () => {
  const db = openSeedDb()
  for (const seed of SEEDS) {
    const id = randomUUID()
    await db.idleTask(id, title(seed), paths.checkout, new Date(Date.now() - seed.minutesAgo * 60_000).toISOString())
    await db.run(`UPDATE task SET status = ? WHERE id = ?`, seed.status, id)
    if (needsYouStatus(seed.status)) {
      await db.run(`UPDATE task SET unseen = true WHERE id = ?`, id)
    }
    if (seed.pinned === true) {
      await db.run(`UPDATE task SET pinned = true WHERE id = ?`, id)
    }
  }
  await db.close()
})

const list = (page: Page) => page.getByRole('main')
const needsYou = (page: Page) => list(page).getByRole('region', { name: 'Needs you' })
const others = (page: Page) => list(page).getByRole('region', { name: 'Other agents' })
const filter = (page: Page) => list(page).getByRole('searchbox', { name: 'Filter agents' })
const filterButton = (page: Page) => page.getByRole('main').getByRole('button', { name: 'Filter agents' })

async function filterBy(page: Page, query: string): Promise<void> {
  if (!(await filter(page).isVisible())) {
    await filterButton(page).click()
  }
  await filter(page).fill(query)
}
const rowTitles = async (region: Locator) =>
  region
    .locator('[data-task-id]')
    .evaluateAll((rows) => rows.map((row) => row.querySelector('button .truncate')?.textContent ?? ''))

test('agents that need you come first, newest failure first, above pinned agents', async ({ page }) => {
  await page.goto('/#agents')
  await expect(needsYou(page)).toBeVisible()
  const header = needsYou(page).getByRole('button', { name: /^Needs you/ })
  await expect(header).toHaveAttribute('aria-expanded', 'true')

  const bar = page.getByRole('contentinfo').getByRole('button', { name: /agents? needs? you$/ })
  const barCount = Number((await bar.getAttribute('aria-label'))?.split(' ')[0])
  await expect(header).toHaveText(new RegExp(`${String(barCount)}$`))

  await filterBy(page, PREFIX)
  await expect(header).toHaveText(/Needs you\s*3$/)
  expect(await rowTitles(needsYou(page))).toEqual([
    title({ name: 'fresh error' }),
    title({ name: 'cut off' }),
    title({ name: 'old error' }),
  ])
  expect(await rowTitles(others(page))).toEqual([
    title({ name: 'pinned idle' }),
    title({ name: 'running' }),
    title({ name: 'stopped' }),
  ])

  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(needsYou(page).getByText(title({ name: 'fresh error' }))).toBeHidden()
  await page.reload()
  await expect(needsYou(page).getByRole('button', { name: /^Needs you/ })).toHaveAttribute('aria-expanded', 'false')
  await needsYou(page)
    .getByRole('button', { name: /^Needs you/ })
    .press('Enter')
  await expect(
    needsYou(page)
      .getByText(title({ name: 'fresh error' }))
      .first(),
  ).toBeVisible()
})

test('opening an agent that needs you takes it out of Needs you and the status bar count', async ({ page }) => {
  const db = openSeedDb()
  const id = randomUUID()
  const name = `Opened error ${randomUUID().slice(0, 6)}`
  await db.idleTask(id, name, paths.checkout, new Date().toISOString())
  await db.run(`UPDATE task SET status = 'error', unseen = true WHERE id = ?`, id)
  await db.close()

  await page.goto('/#agents')
  const row = needsYou(page).locator(`[data-task-id="${id}"]`)
  await expect(row).toBeVisible()
  const bar = page.getByRole('contentinfo').getByRole('button', { name: /agents? needs? you$/ })
  const count = async () =>
    (await bar.count()) === 0 ? 0 : Number((await bar.getAttribute('aria-label'))?.split(' ')[0])
  const before = await count()

  await row.getByRole('button').click()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
  await expect(row).toHaveCount(0)
  await expect(list(page).locator(`[data-task-id="${id}"]`).getByRole('img', { name: 'error' })).toBeVisible()
  await expect.poll(count).toBe(before - 1)
  await page.goto('/#agents')
  await expect(list(page).locator(`[data-task-id="${id}"]`)).toBeVisible()
  await expect(row).toHaveCount(0)
})

test('the status bar item opens the Needs you group, unfolded', async ({ page }) => {
  await page.goto('/#agents')
  const header = needsYou(page).getByRole('button', { name: /^Needs you/ })
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')

  await page.goto('/#settings')
  const item = page.getByRole('contentinfo').getByRole('button', { name: /agents? needs? you$/ })
  await expect(item).toHaveText(/^\d+ need you$/)
  await item.click()
  await expect(page).toHaveURL(/#agents$/)
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(header).toBeFocused()
  await expect(header).toBeInViewport()
})

test('each status has its own named shape', async ({ page }) => {
  await page.goto('/#agents')
  await filterBy(page, PREFIX)
  const glyph = (seed: string, status: string) =>
    list(page)
      .locator('[data-task-id]')
      .filter({ hasText: title({ name: seed }) })
      .getByRole('img', { name: status })
  for (const [seed, status] of [
    ['fresh error', 'error'],
    ['cut off', 'interrupted'],
    ['stopped', 'stopped'],
    ['running', 'running'],
    ['pinned idle', 'idle'],
  ] as const) {
    await expect(glyph(seed, status)).toBeVisible()
    await expect(glyph(seed, status)).toHaveAttribute('title', status)
  }
  const shape = async (seed: string, status: string) => glyph(seed, status).locator('svg').innerHTML()
  const shapes = new Set([
    await shape('fresh error', 'error'),
    await shape('cut off', 'interrupted'),
    await shape('stopped', 'stopped'),
    await shape('running', 'running'),
    await shape('pinned idle', 'idle'),
  ])
  expect(shapes.size).toBe(5)
  const colour = async (seed: string, status: string) =>
    glyph(seed, status).evaluate((node) => getComputedStyle(node).color)
  expect(await colour('cut off', 'interrupted')).not.toBe(await colour('stopped', 'stopped'))
})

test('filters by title, repo and status words, with Alt+/ to focus and Esc to clear', async ({ page }) => {
  await page.goto('/#agents')
  await expect(needsYou(page)).toBeVisible()
  await expect(filter(page), 'the filter waits to be asked for').toHaveCount(0)
  await expect(filterButton(page)).toHaveAttribute('aria-keyshortcuts', 'Alt+/')
  await page.locator('body').press('/')
  await expect(filter(page)).toHaveCount(0)
  await page.locator('body').press('Alt+Slash')
  await expect(filter(page)).toBeFocused()
  await page.keyboard.type(`${PREFIX} interrupted`)
  await expect(list(page).locator('[data-task-id]')).toHaveCount(1)
  await expect(needsYou(page)).toContainText(title({ name: 'cut off' }))

  await filter(page).fill(`${PREFIX} pinned`)
  await expect(list(page).locator('[data-task-id]')).toHaveCount(1)
  await expect(others(page)).toHaveCount(0)
  await expect(list(page).getByRole('region', { name: 'Agents' })).toContainText(title({ name: 'pinned idle' }))

  await filter(page).fill(`${PREFIX} nothing like this`)
  await expect(list(page)).toContainText(`No agents match "${PREFIX} nothing like this".`)
  await filter(page).press('Escape')
  await expect(filter(page)).toHaveValue('')
  await expect(filter(page)).toBeFocused()
  await filter(page).press('Escape')
  await expect(filter(page), 'Esc on an empty filter closes it').toHaveCount(0)

  await page.keyboard.press('Control+Slash')
  const guide = page.getByRole('dialog', { name: 'Shortcuts' })
  await expect(guide.getByRole('region', { name: 'Agents' })).toContainText('Alt+/Filter agents')
})
