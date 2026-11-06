import { expect, test, waitForToastsToClear } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import {
  addMarketplace,
  fakeClaudeCliEnv,
  installGreeter,
  resetFakeClaudeCli,
  uninstallGreeter,
} from './support/plugin-install.js'

test.use({ serverEnv: fakeClaudeCliEnv() })

test.beforeEach(() => {
  resetFakeClaudeCli()
})

test('a phone adds a marketplace, searches it, installs a plugin and uninstalls it', async ({ page }) => {
  await page.goto('/#settings/plugins')
  await addMarketplace(page)
  await expectFitsPhone(page, 'Plugins with a marketplace')

  await page.getByRole('main').getByRole('button', { name: 'Add plugin' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add plugin' })
  await expect(dialog.getByRole('list', { name: 'Marketplace plugins' }).getByRole('button')).toHaveCount(2)
  await expectFitsPhone(page, 'Add plugin')
  await dialog.getByRole('button', { name: 'Close' }).click()

  await installGreeter(page)
  await waitForToastsToClear(page)
  await expectFitsPhone(page, 'Plugins with an installed plugin')
  await uninstallGreeter(page)
})
