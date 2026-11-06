import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { openAgentSettings, showSection } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  return id
}

const listHeader = (page: Page) => page.getByRole('heading', { name: 'Agents', level: 1 }).locator('..')

/** Every control of the header lies inside it and nothing scrolls sideways. */
async function expectFits(header: Locator, where: string): Promise<void> {
  const fit = await header.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const outside = [...element.querySelectorAll('button, h1')].filter((child) => {
      const rect = child.getBoundingClientRect()
      return rect.left < box.left - 0.5 || rect.right > box.right + 0.5
    })
    return { overflow: element.scrollWidth - element.clientWidth, outside: outside.length }
  })
  expect(fit, where).toEqual({ overflow: 0, outside: 0 })
}

test('the Agents header keeps to view, filter, new and one menu, and fits the narrowest list', async ({ page }) => {
  const id = await seedAgent('List header fit')
  await page.goto(`/#agents/${id}`)
  const header = listHeader(page)
  await expect(header.getByRole('button')).toHaveCount(4)
  for (const name of ['Grid', 'Filter agents', 'New agent', 'More list actions']) {
    await expect(header.getByRole('button', { name, exact: true })).toBeVisible()
  }
  await expectFits(header, 'default width')

  const handle = page.getByRole('separator', { name: 'Resize agent list' })
  await handle.focus()
  await page.keyboard.press('Home')
  const min = await handle.getAttribute('aria-valuemin')
  await expect(handle).toHaveAttribute('aria-valuenow', min ?? '')
  await expectFits(header, 'narrowest list')
  await expect(header.getByRole('heading', { name: 'Agents' })).toBeVisible()

  await page.keyboard.press('Alt+g')
  await expect(page.getByTestId('agent-grid')).toBeVisible()
  await expect(header.getByRole('button')).toHaveCount(4)
  await expectFits(header, 'narrowest list in grid mode')
  await page.keyboard.press('Alt+g')
})

test('the list menu works from the keyboard and switches to the archived list and back', async ({ page }) => {
  const id = await seedAgent('List menu keys')
  await page.goto(`/#agents/${id}`)
  const more = listHeader(page).getByRole('button', { name: 'More list actions' })
  await expect(more).toHaveAttribute('aria-haspopup', 'menu')
  await more.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Archived' })).toHaveAttribute('aria-checked', 'false')
  await expect(menu.getByRole('menuitem', { name: 'Import sessions' })).toHaveAttribute('aria-keyshortcuts', 'Alt+I')
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Archived' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Import sessions' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(more).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Archived' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()

  const main = page.getByRole('main')
  await expect(main.getByText('Archived, read-only')).toBeVisible()
  await expect(main.getByRole('button', { name: 'Filter agents' })).toHaveCount(0)
  await main.getByRole('button', { name: 'Active', exact: true }).click()
  await expect(main.getByRole('searchbox', { name: 'Filter agents' }), 'the filter waits to be asked for').toHaveCount(
    0,
  )
  await main.getByRole('button', { name: 'Filter agents' }).click()
  await expect(main.getByRole('searchbox', { name: 'Filter agents' })).toBeFocused()
  await expect(main.locator('[data-task-id] time'), 'agent rows show no age').toHaveCount(0)

  await more.click()
  await page.getByRole('menuitem', { name: 'Import sessions' }).click()
  await expect(page.getByRole('dialog', { name: 'Import sessions' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('the settings tabs move with arrow keys and each holds its rows', async ({ page }) => {
  const id = await seedAgent('Settings tabs keys')
  await page.goto(`/#agents/${id}`)
  const dialog = await openAgentSettings(page)
  const general = dialog.getByRole('tab', { name: 'General' })
  await general.focus()
  for (const [name, row] of [
    ['Access', 'Credentials'],
    ['Team', 'Group chat'],
    ['Session', 'Memory'],
  ] as const) {
    await page.keyboard.press('ArrowRight')
    await expect(dialog.getByRole('tab', { name })).toBeFocused()
    await expect(dialog.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
    await expect(dialog.getByRole('tabpanel', { name }).locator('dt', { hasText: row })).toBeVisible()
  }
  await showSection(dialog, 'General')
  await expect(dialog.getByRole('combobox', { name: 'Credentials' })).toHaveCount(0)
  await showSection(dialog, 'Access')
  await expect(dialog.getByRole('combobox', { name: 'Credentials' })).toBeVisible()
  await showSection(dialog, 'Session')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('>change role')
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByRole('combobox', { name: 'Role' })).toBeFocused()
})
