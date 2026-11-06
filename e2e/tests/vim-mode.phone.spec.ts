import { expect, test } from './support/fixtures.js'
import { modToggle, setModEnabled } from './support/mods.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.afterEach(async ({ request }) => {
  await setModEnabled(request, 'vim', false)
})

test('the phone turns Vim mode on in Settings, Mods, and takes no Vim keys or status item', async ({ page }) => {
  await page.goto('/#settings/mods')
  const toggle = modToggle(page, 'Vim mode')
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expectFitsPhone(page, 'mods settings with Vim mode on')

  await page.goto('/#agents')
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  for (const key of ['j', 'k', 'G', '?', 'Escape']) {
    await page.keyboard.press(key)
  }
  await expect(page.getByRole('dialog', { name: 'Vim mode keys' })).toHaveCount(0)
  await expect(page.getByTestId('vim-mode')).toHaveCount(0)
  await expect(page.locator('[data-panel-active]')).toHaveCount(0)

  await page.goto('/#settings/mods')
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})
