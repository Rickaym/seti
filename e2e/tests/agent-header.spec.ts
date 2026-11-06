import { randomUUID } from 'node:crypto'
import type { Locator } from '@playwright/test'
import { expectGroupedSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const TITLE = 'Migrate the dashboard websocket reconnection logic to the exponential backoff helper and retry'
const PRS = 4

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  expect(found, 'bounding box').not.toBeNull()
  return found ?? { x: 0, y: 0, width: 0, height: 0 }
}

test('the title and actions share a row and the PR line spans the header under both', async ({ page }) => {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, TITLE, paths.checkout, at)
  for (let n = 1; n <= PRS; n += 1) {
    const url = `https://github.com/e2e/dashboard/pull/${String(400 + n)}`
    await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, id, url, at)
  }
  await db.close()
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const title = main.getByRole('heading', { name: TITLE, level: 2 })
  await expect(title).toBeVisible()
  const chips = main.getByRole('group', { name: /^Pull request dashboard#/ })
  await expect(chips).toHaveCount(PRS)
  expect(await title.evaluate((h) => h.scrollWidth > h.clientWidth)).toBe(true)

  const heading = await box(title)
  const find = await box(main.getByRole('button', { name: 'Find in this chat' }))
  const settings = await box(main.getByRole('button', { name: 'Agent settings' }))
  for (const action of [find, settings]) {
    const middle = action.y + action.height / 2
    expect(middle).toBeGreaterThan(heading.y)
    expect(middle).toBeLessThan(heading.y + heading.height)
  }

  const whereText = main.getByTitle(paths.checkout, { exact: true })
  const where = await box(whereText)
  expect(Math.abs(where.x - heading.x)).toBeLessThanOrEqual(1)
  expect(where.y).toBeGreaterThanOrEqual(Math.max(heading.y + heading.height, find.y + find.height) - 1)
  const last = await box(chips.last())
  expect(last.y).toBeLessThan(where.y + where.height)
  const line = await box(whereText.locator('..'))
  expect(line.x + line.width).toBeGreaterThan(settings.x + settings.width - 1)
  expect(line.height).toBeLessThan(where.height * 2)
})

test('agent settings group their rows under section labels with the session actions last', async ({ page }) => {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, 'E2E grouped settings', paths.checkout, new Date().toISOString())
  await db.close()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).click()
  await expectGroupedSettings(page.getByRole('dialog'))
})

test('header buttons show their words in a wide pane, and an empty transcript says how to start', async ({ page }) => {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, 'E2E header words', paths.checkout, new Date().toISOString())
  await db.close()
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const words = [
    ['Find in this chat', 'Find'],
    ['Processes', 'Processes'],
    ['Files', 'Files'],
    ['Pin', 'Pin'],
    ['Agent settings', 'Settings'],
  ] as const
  for (const [name, word] of words) {
    await expect(main.getByRole('button', { name, exact: true }).getByText(word, { exact: true })).toBeVisible()
  }
  await expect(main.getByRole('region', { name: 'Transcript' })).toContainText(
    "No messages yet. A reply below starts this agent's first turn.",
  )
  await page.setViewportSize({ width: 1100, height: 900 })
  for (const [name, word] of words) {
    await expect(main.getByRole('button', { name, exact: true }).getByText(word, { exact: true })).toBeHidden()
  }
})
