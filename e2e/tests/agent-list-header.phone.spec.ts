import { randomUUID } from 'node:crypto'
import type { Locator } from '@playwright/test'
import { openAgentSettings, showSection, type SettingsSection } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const TARGET_PX = 44

async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  return id
}

async function smallest(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  return Math.min(box?.width ?? 0, box?.height ?? 0)
}

test('the Agents header on a phone holds new and the menu, fits, and its menu reaches import', async ({ page }) => {
  await seedAgent('Phone list header')
  await page.goto('/#agents')
  const header = page.getByRole('heading', { name: 'Agents', level: 1 }).locator('..')
  await expect(header.getByRole('button')).toHaveCount(3)
  for (const name of ['Filter agents', 'New agent', 'More list actions']) {
    expect(await smallest(header.getByRole('button', { name })), name).toBeGreaterThanOrEqual(TARGET_PX)
  }
  expect(await header.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0)
  await expectFitsPhone(page, 'agent list header')

  await header.getByRole('button', { name: 'More list actions' }).tap()
  for (const item of [
    page.getByRole('menuitemcheckbox', { name: 'Archived' }),
    page.getByRole('menuitem', { name: 'Import sessions' }),
  ]) {
    await expect(item).toBeInViewport({ ratio: 0.99 })
    await expect.poll(async () => Math.round((await item.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(TARGET_PX)
  }
  await page.getByRole('menuitemcheckbox', { name: 'Archived' }).tap()
  await expect(page.getByRole('main').getByText('Archived, read-only')).toBeVisible()
  expect(
    await smallest(page.getByRole('main').getByRole('button', { name: 'Active', exact: true })),
  ).toBeGreaterThanOrEqual(TARGET_PX)
})

test('every settings tab is reachable on a phone with touch-sized tabs and the actions in view', async ({ page }) => {
  const id = await seedAgent('Phone settings tabs')
  await page.goto(`/#agents/${id}`)
  const sheet = await openAgentSettings(page)
  const sections: readonly SettingsSection[] = ['General', 'Access', 'Team', 'Session']
  for (const name of sections) {
    const tab = sheet.getByRole('tab', { name })
    await expect(tab).toBeInViewport({ ratio: 1 })
    expect((await tab.boundingBox())?.height ?? 0, name).toBeGreaterThanOrEqual(TARGET_PX)
    const panel = await showSection(sheet, name)
    await expect(panel.locator('dt').first()).toBeInViewport()
    await expect(sheet.getByRole('button', { name: 'Archive', exact: true })).toBeInViewport({ ratio: 1 })
    await expectFitsPhone(page, `${name} settings tab`)
  }
})

test('the agent filter on a phone hides behind the search button until opened', async ({ page }) => {
  await seedAgent('Phone filter alpha')
  await seedAgent('Phone filter beta')
  await page.goto('/#agents')
  const main = page.getByRole('main')
  const field = main.getByRole('searchbox', { name: 'Filter agents' })
  await expect(field).toHaveCount(0)

  const header = page.getByRole('heading', { name: 'Agents', level: 1 }).locator('..')
  const toggle = header.getByRole('button', { name: 'Filter agents' })
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(field).toBeFocused()
  await field.fill('alpha')
  await expect(main.getByText('Phone filter alpha')).toBeVisible()
  await expect(main.getByText('Phone filter beta')).toHaveCount(0)

  await toggle.tap()
  await expect(field).toHaveCount(0)
  await expect(main.getByText('Phone filter beta')).toBeVisible()
})
