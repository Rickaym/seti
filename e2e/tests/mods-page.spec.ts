import { expect, test } from './support/fixtures.js'
import { modToggle, setModEnabled } from './support/mods.js'

test.afterEach(async ({ request }) => {
  await setModEnabled(request, 'vim', false)
})

test('the mods list finds mods by words and filters them by state and source', async ({ page }) => {
  await page.goto('/#settings/mods')
  const main = page.getByRole('main')
  const list = main.getByRole('region', { name: 'Mods' })
  const rows = list.getByRole('listitem')
  const previews = list.getByRole('listitem', { name: 'Previews', exact: true })
  await expect(previews).toContainText(
    'Shows PDFs page by page, CSV files and workbooks as tables, and Mermaid diagrams',
  )
  await expect(previews).toContainText('Seti')
  await expect(previews.getByText('Core', { exact: true })).toBeVisible()
  await expect(list.getByRole('listitem', { name: 'Weather' }).getByText('Bundled', { exact: true })).toBeVisible()

  const search = main.getByRole('searchbox', { name: 'Search mods' })
  await search.fill('diagrams')
  await expect(rows).toHaveCount(1)
  await expect(previews).toBeVisible()
  await search.fill('viewers')
  await expect(list.getByRole('listitem', { name: 'HTML preview' })).toBeVisible()
  await expect(list.getByRole('listitem', { name: 'Weather' })).toHaveCount(0)
  await search.fill('nothing like this')
  await expect(list).toContainText('No mod matches "nothing like this".')
  await list.getByRole('button', { name: 'Show all' }).click()
  await expect(search).toHaveValue('')

  await main.getByRole('tab', { name: /^Disabled/ }).click()
  await expect(list.getByRole('listitem', { name: 'Vim mode' })).toBeVisible()
  await expect(list.getByRole('listitem', { name: 'Weather' })).toHaveCount(0)
  await modToggle(page, 'Vim mode').click()
  await expect(list.getByRole('listitem', { name: 'Vim mode' })).toHaveCount(0)
  await main.getByRole('tab', { name: /^Enabled/ }).click()
  await expect(modToggle(page, 'Vim mode')).toHaveAttribute('aria-pressed', 'true')
  await main.getByRole('tab', { name: /^Installed/ }).click()
  await expect(list.getByRole('listitem', { name: 'View test' })).toContainText('Unknown publisher')
  await expect(list.getByRole('listitem', { name: 'Vim mode' })).toHaveCount(0)
  await main.getByRole('tab', { name: /^Updates/ }).click()
  await expect(list).toContainText('Every mod is up to date.')
})

test("a mod's page reads its README, permissions, settings, contributions and changelog by deep link", async ({
  page,
}) => {
  await page.goto('/#settings/mods')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Open Weather' }).click()
  await expect(page).toHaveURL(/#settings\/mods\/weather$/)
  await expect(main.getByRole('heading', { name: 'Weather', level: 2 })).toBeVisible()
  const about = main.getByRole('definition')
  await expect(about.filter({ hasText: 'Bundled with Seti' })).toHaveCount(1)
  await expect(about.filter({ hasText: 'Appearance' })).toHaveCount(1)

  await main.getByRole('tab', { name: 'Permissions' }).click()
  await expect(page).toHaveURL(/#settings\/mods\/weather\/permissions$/)
  await expect(main.getByRole('list', { name: 'What Weather may do' })).toContainText(
    'Sends and receives data with api.open-meteo.com. It can send what it reads there.',
  )
  await page.reload()
  await expect(main.getByRole('tab', { name: 'Permissions' })).toHaveAttribute('aria-selected', 'true')

  await main.getByRole('tab', { name: 'Settings' }).click()
  await expect(main.getByRole('combobox', { name: 'Units' })).toHaveValue('Celsius')
  await main.getByRole('tab', { name: 'Contributes' }).click()
  await expect(main.getByRole('region', { name: 'Views' })).toContainText('Daylight')
  await expect(main.getByRole('region', { name: 'Views' })).toContainText('The band across the header, on phones too.')
  await main.getByRole('tab', { name: 'Changelog' }).click()
  await expect(main.getByText('The first version, bundled with Seti.')).toBeVisible()
  await expect(main.getByRole('tab', { name: 'Versions' })).toHaveCount(0)
})

test("a mod's own page turns it on and off, and the list agrees", async ({ page }) => {
  await page.goto('/#settings/mods/vim')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Vim mode', level: 2 })).toBeVisible()
  await main.getByRole('button', { name: 'Off', exact: true }).click()
  await expect(main.getByRole('button', { name: 'On', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await main.getByRole('button', { name: 'Back to mods' }).click()
  await expect(modToggle(page, 'Vim mode')).toHaveAttribute('aria-pressed', 'true')
  await page.goto('/#settings/mods/no-such-mod')
  await expect(main).toContainText('Seti has no mod no-such-mod. It may have been uninstalled.')
})

test('a required mod shows Core with no switch, its page says it is part of Seti, and its settings still change', async ({
  page,
  request,
}) => {
  await page.goto('/#settings/mods')
  const main = page.getByRole('main')
  const list = main.getByRole('region', { name: 'Mods' })
  const previews = list.getByRole('listitem', { name: 'Previews', exact: true })
  await expect(previews.getByText('Core', { exact: true })).toBeVisible()
  await expect(previews.getByText('Bundled', { exact: true })).toHaveCount(0)
  await expect(previews.getByRole('img', { name: 'Always on' })).toBeVisible()
  await expect(modToggle(page, 'Previews')).toHaveCount(0)
  for (const filter of ['Enabled', 'Bundled']) {
    await main.getByRole('tab', { name: new RegExp(`^${filter}`) }).click()
    await expect(previews).toBeVisible()
  }
  await main.getByRole('tab', { name: /^Disabled/ }).click()
  await expect(previews).toHaveCount(0)
  await main.getByRole('tab', { name: /^All/ }).click()

  await previews.getByRole('button', { name: 'Open Previews' }).click()
  await expect(main.getByRole('heading', { name: 'Previews', level: 2 })).toBeVisible()
  await expect(main.getByText('Part of Seti, so it is always on.')).toBeVisible()
  await expect(main.getByRole('button', { name: /^(On|Off)$/ })).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Uninstall' })).toHaveCount(0)

  await main.getByRole('tab', { name: 'Settings' }).click()
  const pdf = main.getByRole('button', { name: 'PDF', exact: true })
  await expect(pdf).toHaveAttribute('aria-pressed', 'true')
  await pdf.click()
  await expect(pdf).toHaveAttribute('aria-pressed', 'false')
  await pdf.click()
  await expect(pdf).toHaveAttribute('aria-pressed', 'true')
  const refused = await request.patch('/api/mods/previews', { data: { enabled: false } })
  expect(refused.status()).toBe(409)
})
