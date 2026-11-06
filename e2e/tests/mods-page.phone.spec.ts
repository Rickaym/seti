import { expect, test } from './support/fixtures.js'
import { modToggle, setModEnabled } from './support/mods.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.afterEach(async ({ request }) => {
  await setModEnabled(request, 'vim', false)
})

test('the phone searches and filters mods, opens one, reads its tabs and goes back', async ({ page }) => {
  await page.goto('/#settings/mods')
  const main = page.getByRole('main')
  const list = main.getByRole('region', { name: 'Mods' })
  await expect(list.getByRole('listitem', { name: 'Weather' })).toBeVisible()
  await expectFitsPhone(page, 'the mods list')

  await main.getByRole('searchbox', { name: 'Search mods' }).fill('keyboard')
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await modToggle(page, 'Vim mode').tap()
  await expect(modToggle(page, 'Vim mode')).toHaveAttribute('aria-pressed', 'true')
  await main.getByRole('tab', { name: /^Disabled/ }).tap()
  await expect(list).toContainText('No mod matches "keyboard".')
  await main.getByRole('button', { name: 'Clear search' }).tap()
  await expect(list.getByRole('listitem', { name: 'Vim mode' })).toHaveCount(0)
  await expectFitsPhone(page, 'the mods list filtered')

  await main.getByRole('tab', { name: /^All/ }).tap()
  await list.getByRole('button', { name: 'Open Weather' }).tap()
  await expect(main.getByRole('heading', { name: 'Weather', level: 2 })).toBeVisible()
  await expectFitsPhone(page, "a mod's page")
  for (const tab of ['Permissions', 'Settings', 'Contributes', 'Changelog']) {
    await main.getByRole('tab', { name: tab }).tap()
    await expect(main.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
    await expectFitsPhone(page, `a mod's ${tab} tab`)
  }
  await main.getByRole('button', { name: 'Back to mods' }).tap()
  await expect(main.getByRole('heading', { name: 'Mods', level: 2 })).toBeVisible()
})

test('the phone shows a required mod as Core with no switch, and switches one of its settings', async ({ page }) => {
  await page.goto('/#settings/mods')
  const main = page.getByRole('main')
  const list = main.getByRole('region', { name: 'Mods' })
  await main.getByRole('searchbox', { name: 'Search mods' }).fill('diagrams')
  const previews = list.getByRole('listitem', { name: 'Previews', exact: true })
  await expect(previews.getByText('Core', { exact: true })).toBeVisible()
  await expect(modToggle(page, 'Previews')).toHaveCount(0)
  await expectFitsPhone(page, 'a required mod in the list')

  await previews.getByRole('button', { name: 'Open Previews' }).tap()
  await expect(main.getByText('Part of Seti, so it is always on.')).toBeVisible()
  await expect(main.getByRole('button', { name: /^(On|Off)$/ })).toHaveCount(0)
  await expectFitsPhone(page, "a required mod's page")
  await main.getByRole('tab', { name: 'Settings' }).tap()
  const sheets = main.getByRole('button', { name: 'Spreadsheets and CSV', exact: true })
  await sheets.tap()
  await expect(sheets).toHaveAttribute('aria-pressed', 'false')
  await sheets.tap()
  await expect(sheets).toHaveAttribute('aria-pressed', 'true')
})
