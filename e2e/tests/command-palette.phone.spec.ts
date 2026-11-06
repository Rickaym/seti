import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'

/** Phones have no Ctrl+K: the shortcut guide in the menu drawer offers the palette too. */
async function openFromGuide(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Shortcuts' }).click()
  const guide = page.getByRole('dialog', { name: 'Shortcuts' })
  await expect(guide).toBeVisible()
  await expect(guide.getByRole('region', { name: 'Agent status' })).toBeVisible()
  await expect(guide.getByRole('region', { name: 'Anywhere' })).toHaveCount(0)
  await expect(guide).not.toContainText(/\b(Alt|Opt|Ctrl|Cmd)\+/)
  await guide.getByRole('button', { name: 'Open command palette' }).click()
  await expect(guide).toBeHidden()
}

test('opens the palette as a full screen sheet with one tap on the header search', async ({ page }) => {
  await page.goto('/#agents')
  const viewport = page.viewportSize() ?? { width: 0, height: 0 }
  const search = page.getByRole('banner').getByRole('button', { name: 'Search' })
  const target = await search.boundingBox()
  expect(Math.min(target?.width ?? 0, target?.height ?? 0)).toBeGreaterThanOrEqual(44)
  await search.tap()
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await expect(palette).toBeVisible()
  await expect
    .poll(async () => {
      const box = await palette.boundingBox()
      return box === null ? null : { width: Math.round(box.width), height: Math.round(box.height) }
    })
    .toEqual({ width: viewport.width, height: viewport.height })
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(scroll).toBe(0)

  await palette.getByRole('combobox').fill('context')
  await palette
    .getByRole('group', { name: 'Sections' })
    .getByRole('option', { name: /^Context/ })
    .click()
  await expect(page).toHaveURL(/#context$/)
  await expect(palette).toBeHidden()

  await openFromGuide(page)
  await palette.getByRole('button', { name: 'Close' }).click()
  await expect(palette).toBeHidden()
})
