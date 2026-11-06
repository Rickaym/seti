import type { AuditPage } from '@seti/shared'
import { apiData, expect, test, waitForToastsToClear } from './support/fixtures.js'
import {
  addMarketplace,
  fakeChanges,
  fakeClaudeCliEnv,
  installGreeter,
  MARKET,
  resetFakeClaudeCli,
  uninstallGreeter,
} from './support/plugin-install.js'

test.use({ serverEnv: fakeClaudeCliEnv() })

test.beforeEach(() => {
  resetFakeClaudeCli()
})

test('add a marketplace, install a plugin from it, turn it off and uninstall it', async ({ page, request }) => {
  await page.goto('/#settings/plugins')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Refresh' }).click()
  await addMarketplace(page)
  await installGreeter(page)

  await waitForToastsToClear(page)
  const row = main.getByRole('button', { name: 'greeter plugin' })
  await expect(row).toContainText('enabled')
  await main.getByRole('switch', { name: 'greeter enabled' }).click()
  await expect(row).toContainText('disabled')

  await waitForToastsToClear(page)
  await uninstallGreeter(page)

  const id = `greeter@${MARKET.name}`
  expect(fakeChanges()).toEqual([
    ['plugin', 'marketplace', 'add', '--json', '--', MARKET.source],
    ['plugin', 'install', '--json', '--scope', 'user', '--', id],
    ['plugin', 'disable', '--json', '--scope', 'user', '--', id],
    ['plugin', 'uninstall', '--json', '--scope', 'user', '--', id],
  ])
  const audit = await apiData<AuditPage>(request, '/audit?kind=plugin&limit=20')
  expect(audit.events.map((event) => event.kind).reverse()).toEqual([
    'plugin.marketplace_added',
    'plugin.installed',
    'plugin.disabled',
    'plugin.uninstalled',
  ])
})

test('update and remove a marketplace', async ({ page }) => {
  await page.goto('/#settings/plugins')
  await addMarketplace(page)
  const main = page.getByRole('main')
  await waitForToastsToClear(page)
  await main.getByRole('button', { name: `Update ${MARKET.name}` }).click()
  await expect(page.getByText(`Updated ${MARKET.name}`)).toBeVisible()
  await main.getByRole('button', { name: `Remove ${MARKET.name}` }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove marketplace' })
  await expect(confirm).toContainText(MARKET.source)
  await confirm.getByRole('button', { name: 'Remove' }).click()
  await expect(confirm).toBeHidden()
  await expect(main.getByRole('listitem', { name: `${MARKET.name} marketplace` })).toHaveCount(0)
})

test.describe('refusals', () => {
  test.use({ allowedHttpStatuses: [400] })

  test('explains a marketplace source that is not allowed and one the CLI cannot add', async ({ page }) => {
    await page.goto('/#settings/plugins')
    await page.getByRole('main').getByRole('button', { name: 'Add marketplace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add marketplace' })
    await dialog.getByLabel('Marketplace source').fill('--upload-pack=touch /tmp/x')
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText('A source cannot start with -')).toBeVisible()
    await dialog.getByLabel('Marketplace source').fill('acme/missing')
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText('Failed to clone marketplace repository: acme/missing')).toBeVisible()
    await expect(dialog).toBeVisible()
    expect(fakeChanges()).toEqual([['plugin', 'marketplace', 'add', '--json', '--', 'acme/missing']])
  })
})
