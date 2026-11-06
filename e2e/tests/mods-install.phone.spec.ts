import { expect, test } from './support/fixtures.js'
import { cleanUpMod, openModsInDevMode, writeModPackage } from './support/mod-packages.js'
import { expectFitsPhone } from './support/phone-layout.js'

const ID = 'pocket'

test.afterEach(async ({ request }) => {
  await cleanUpMod(request, ID)
})

test('the phone adds a mod on its own page, reads its consent, manages it and uninstalls it', async ({ page }) => {
  const folder = writeModPackage(ID, ['api.pocket.example'])
  await openModsInDevMode(page)
  await expectFitsPhone(page, 'mods settings in Developer mode')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Add', exact: true }).click()
  await main.getByRole('textbox', { name: 'Folder' }).fill(folder)
  await main.getByRole('button', { name: 'Check' }).click()
  const check = main.getByRole('region', { name: 'Check' })
  await expect(check.getByRole('list', { name: 'What Pocket can do' })).toContainText(
    'Sends and receives data with api.pocket.example.',
  )
  await expectFitsPhone(page, 'the consent step')
  await check.getByRole('button', { name: 'Install' }).click()

  await expect(main.getByRole('heading', { name: 'Pocket', level: 2 })).toBeVisible()
  await expect(main.getByText('Shows how a third-party mod installs.').first()).toBeVisible()
  await expectFitsPhone(page, "an installed mod's page")
  await main.getByRole('tab', { name: 'Versions' }).click()
  await expect(main.getByRole('button', { name: 'Check' })).toBeVisible()
  await expectFitsPhone(page, "an installed mod's versions")
  await main.getByRole('button', { name: 'Uninstall' }).click()
  await page.getByRole('dialog', { name: 'Uninstall Pocket?' }).getByRole('button', { name: 'Uninstall' }).click()
  await expect(main.getByRole('region', { name: 'Mods' })).not.toContainText('Pocket')
})
