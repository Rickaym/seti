import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { modToggle, resetThemes } from './support/themes.js'

const CLAUDE = 'claude-theme.claude'

test.afterEach(async ({ request }) => {
  await resetThemes(request)
})

test('the phone picks a mod theme, shows the default while the mod is off, and gets it back', async ({ page }) => {
  const html = page.locator('html')
  const themes = page.getByRole('main').getByRole('group', { name: 'Theme' })
  await page.goto('/#settings/general')
  await themes.getByRole('button', { name: 'Claude', exact: true }).click()
  await expect(themes.getByRole('button', { name: 'Claude', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(html).toHaveAttribute('data-theme', CLAUDE)
  await expectFitsPhone(page, 'the theme picker')

  await page.goto('/#settings/mods')
  await modToggle(page, 'Claude theme').scrollIntoViewIfNeeded()
  await modToggle(page, 'Claude theme').click()
  await expect(modToggle(page, 'Claude theme')).toHaveAttribute('aria-pressed', 'false')
  await expect(html).toHaveAttribute('data-theme', 'default')
  await page.goto('/#settings/general')
  await expect(themes.getByRole('button', { name: 'Claude', exact: true })).toHaveCount(0)
  await expect(themes.getByRole('button', { name: 'Default', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await page.goto('/#settings/mods')
  await modToggle(page, 'Claude theme').scrollIntoViewIfNeeded()
  await modToggle(page, 'Claude theme').click()
  await expect(html).toHaveAttribute('data-theme', CLAUDE)
})
