import { seeChangelogBefore } from './support/changelog-news.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('on a phone the menu carries the news dot to the About page in Settings that fits the screen', async ({
  page,
  request,
}) => {
  await seeChangelogBefore(request)
  await page.goto('/#agents')
  const menu = page.getByRole('button', { name: 'Menu' })
  await expect(menu.locator('[data-news]')).toBeVisible()
  await menu.click()

  const settings = page.getByRole('dialog').getByRole('button', { name: 'Settings' })
  await expect(settings.locator('[data-news]')).toBeVisible()
  await settings.click()

  const main = page.getByRole('main')
  const item = main.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'About' })
  await expect(item.locator('[data-news]')).toBeVisible()
  await item.click()
  await expect(page).toHaveURL(/#settings\/about$/)

  await expect(main.locator('[data-update="available"]')).toContainText('2 new commits on main')
  await expect(main.locator('li[data-commit]').filter({ has: page.locator('[data-news]') })).toHaveCount(3)
  const breaking = main.getByRole('listitem').filter({ hasText: 'keep tools within the limit' })
  await breaking.getByRole('button', { expanded: false }).click()
  await expect(breaking.locator('strong')).toHaveText('quiet')
  await main.getByRole('button', { name: 'Upkeep' }).click()
  await expect(main.getByRole('listitem').filter({ hasText: 'bump zod' })).toBeVisible()
  await expectFitsPhone(page, 'About')

  await expect(menu.locator('[data-news]')).toHaveCount(0)
})
