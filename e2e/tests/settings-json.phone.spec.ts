import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const main = (page: Page) => page.getByRole('main')
const section = (page: Page, path: string) => main(page).getByRole('region', { name: path, exact: true })

test('the JSON page reads, searches and exports on a phone', async ({ page }) => {
  await page.goto('/#settings')
  await main(page).getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'JSON' }).tap()
  await expect(main(page).getByRole('heading', { name: 'JSON', level: 2, exact: true })).toBeVisible()
  await expect(section(page, 'security.sandbox')).toBeVisible()
  await expectFitsPhone(page, 'settings JSON')

  await main(page).getByRole('textbox', { name: 'Search settings' }).fill('allowed_domains')
  await expect(section(page, 'security.sandbox')).toContainText('"allowed_domains"')
  await expect(section(page, 'app.general')).toBeHidden()
  await expectFitsPhone(page, 'settings JSON search')

  const download = page.waitForEvent('download')
  await main(page).getByRole('button', { name: 'Export' }).tap()
  expect((await download).suggestedFilename()).toMatch(/^seti-settings-.*\.json$/)
})
