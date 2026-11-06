import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { Task } from '@seti/shared'
import { expectGroupedSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'
import { openAgentPrs } from './support/phone-agent.js'
import { edgesAtRest, expectFitsPhone } from './support/phone-layout.js'

const TITLE = 'Migrate the dashboard websocket reconnection logic to the exponential backoff helper'
const PR = 'https://github.com/e2e/dashboard/pull/412'
const LINKED = 'https://github.com/e2e/dashboard/pull/413'
/** The terminal bar's 44px row and its rule, which the phone agent header shares. */
const HEADER_PX = 45
const TARGET_PX = 44

async function seedAgent(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, TITLE, paths.checkout, at)
  await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, id, PR, at)
  await db.close()
  return id
}

async function openAgent(page: Page): Promise<string> {
  const id = await seedAgent()
  await page.goto(`/#agents/${id}`)
  await expect(page.getByRole('main').getByRole('heading', { name: TITLE, level: 2 })).toBeVisible()
  return id
}

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  expect(found, 'bounding box').not.toBeNull()
  return found ?? { x: 0, y: 0, width: 0, height: 0 }
}

const viewport = (page: Page) => page.viewportSize() ?? { width: 0, height: 0 }

test('the agent header is the terminal bar: back, status, title and two actions in one row', async ({ page }) => {
  await openAgent(page)
  const header = page.getByTestId('agent-header')
  const title = header.getByRole('heading', { name: TITLE, level: 2 })
  expect((await edgesAtRest(page, header)).height).toBe(HEADER_PX)
  await expect(header.getByRole('img', { name: 'idle' })).toBeVisible()
  expect(await title.evaluate((h) => h.scrollWidth > h.clientWidth)).toBe(true)
  const titleBox = await box(title)
  for (const name of ['Back to agents', 'Agent settings', 'More actions']) {
    const button = await box(header.getByRole('button', { name }))
    expect(Math.min(button.width, button.height), name).toBeGreaterThanOrEqual(TARGET_PX)
    expect(Math.abs(button.y + button.height / 2 - (titleBox.y + titleBox.height / 2)), name).toBeLessThan(2)
  }
  await expect(header.getByText('checkout', { exact: true })).toHaveCount(0)
  await expect(header.getByRole('group', { name: /^Pull request/ })).toHaveCount(0)
  await expectFitsPhone(page, 'agent header')
})

test('linked PRs open from the More sheet with touch-sized rows and unlink', async ({ page }) => {
  await openAgent(page)
  const sheet = await openAgentPrs(page)
  const row = sheet.getByRole('listitem', { name: 'Pull request dashboard#412' })
  for (const [name, target] of [
    ['Row', row],
    ['Unlink', row.getByRole('button', { name: 'Unlink dashboard#412' })],
  ] as const) {
    const found = await box(target)
    expect(Math.min(found.width, found.height), name).toBeGreaterThanOrEqual(TARGET_PX)
  }
  await expectFitsPhone(page, 'linked PRs sheet')
  await sheet.getByRole('button', { name: 'Close linked PRs' }).tap()
  await expect(sheet).toBeHidden()
})

test('with no PR linked the Pull requests sheet offers Link PR, and a pasted URL links one', async ({
  page,
  request,
}) => {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, 'E2E phone link PR', paths.checkout, new Date().toISOString())
  await db.close()
  await page.goto(`/#agents/${id}`)
  const sheet = await openAgentPrs(page)
  await expect(sheet.getByRole('textbox', { name: 'Filter linked PRs' })).toHaveCount(0)
  const link = sheet.getByRole('button', { name: 'Link PR' })
  expect((await box(link)).height).toBeGreaterThanOrEqual(TARGET_PX)
  await link.tap()
  await sheet.getByRole('textbox', { name: 'Pull request URL' }).fill(LINKED)
  await sheet.getByRole('button', { name: 'Link', exact: true }).tap()
  await expect(sheet.getByRole('listitem', { name: 'Pull request dashboard#413' })).toBeVisible()
  await expect(link).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).pr_urls).toEqual([LINKED])
  await expectFitsPhone(page, 'linked PRs sheet after linking')
})

test('agent settings open as a bottom sheet with every row and action in reach', async ({ page }) => {
  await openAgent(page)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).tap()
  const sheet = page.getByRole('dialog', { name: 'Agent settings' })
  await expect(sheet.getByLabel('Agent details')).toBeVisible()
  const edges = await edgesAtRest(page, sheet)
  expect(edges.top).toBeGreaterThan(0)
  expect(edges.bottom).toBeLessThanOrEqual(viewport(page).height + 1)
  for (const name of ['Restart session', 'Fresh session', 'Archive']) {
    const button = sheet.getByRole('button', { name, exact: true })
    await expect(button).toBeInViewport({ ratio: 1 })
    expect((await box(button)).height, name).toBeGreaterThanOrEqual(TARGET_PX)
  }
  const role = sheet.getByRole('combobox', { name: 'Role' })
  await role.scrollIntoViewIfNeeded()
  await expect(role).toBeInViewport({ ratio: 1 })
  const roleBox = await box(role)
  const footer = await box(sheet.getByRole('button', { name: 'Restart session' }))
  expect(roleBox.y + roleBox.height).toBeLessThanOrEqual(footer.y)
  await expectFitsPhone(page, 'agent settings sheet')
  await sheet.getByRole('button', { name: 'Close agent settings' }).tap()
  await expect(sheet).toBeHidden()
})

test('the settings sheet groups its rows like the desktop popover, with the session actions last', async ({ page }) => {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, 'E2E grouped sheet', paths.checkout, new Date().toISOString())
  await db.close()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).tap()
  await expectGroupedSettings(page.getByRole('dialog', { name: 'Agent settings' }))
  await expectFitsPhone(page, 'grouped agent settings sheet')
})

test('the overflow sheet renames, pins and opens files and processes', async ({ page }) => {
  const id = await openAgent(page)
  const main = page.getByRole('main')
  const actions = page.getByRole('dialog', { name: 'Agent actions' })
  await main.getByRole('button', { name: 'More actions' }).tap()
  await actions.getByRole('button', { name: 'Rename' }).tap()
  await expect(actions).toBeHidden()
  const field = main.getByRole('textbox', { name: 'Agent name' })
  await field.fill('Backoff on phone')
  await field.press('Enter')
  await expect(main.getByRole('heading', { name: 'Backoff on phone', level: 2 })).toBeVisible()

  await main.getByRole('button', { name: 'More actions' }).tap()
  await actions.getByRole('button', { name: 'Pin' }).tap()
  await main.getByRole('button', { name: 'More actions' }).tap()
  await expect(actions.getByRole('button', { name: 'Unpin' })).toBeVisible()
  await actions.getByRole('button', { name: 'Processes' }).tap()
  await expect(page.getByRole('dialog', { name: 'Processes' })).toBeVisible()
  await page.getByRole('button', { name: 'Close processes' }).tap()
  await expect(page.getByRole('dialog', { name: 'Processes' })).toBeHidden()

  await main.getByRole('button', { name: 'More actions' }).tap()
  await actions.getByRole('button', { name: 'Files' }).tap()
  await expect(page.getByRole('region', { name: 'Files', exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}`))
})
