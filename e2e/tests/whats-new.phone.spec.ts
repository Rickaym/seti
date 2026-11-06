import { seeChangelogBefore } from './support/changelog-news.js'
import { expect, test } from './support/fixtures.js'
import { modToggle } from './support/mods.js'
import { expectFitsPhone } from './support/phone-layout.js'

test("on a phone What's new is part of Seti: no switch, and its dot and About page stay", async ({ page, request }) => {
  await seeChangelogBefore(request)
  await page.goto('/#settings/mods')
  const main = page.getByRole('main')
  const menu = page.getByRole('button', { name: 'Menu' })
  await expect(menu.locator('[data-news]')).toBeVisible()

  const row = main.getByRole('region', { name: 'Mods' }).getByRole('listitem', { name: "What's new" })
  await row.scrollIntoViewIfNeeded()
  await expect(row.getByText('Core', { exact: true })).toBeVisible()
  await expect(modToggle(page, "What's new")).toHaveCount(0)
  await expectFitsPhone(page, "mods settings with What's new always on")
  await page.goto('/#settings')
  const nav = main.getByRole('navigation', { name: 'Settings pages' })
  await nav.getByRole('button', { name: 'About' }).click()
  await expect(main.locator('[data-update="available"]')).toContainText('2 new commits on main')
  await expectFitsPhone(page, 'About')
})
