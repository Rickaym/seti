import type { Connection, CredentialsOverview } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const KEY = `pv-${'Ph0n'.repeat(8)}`

test.afterEach(async ({ request }) => {
  for (const connection of await apiData<Connection[]>(request, '/connections')) {
    await request.delete(`/api/connections/${connection.id}`)
  }
})

test('a connection is added, filled in and given to a credential on a phone', async ({ page, request }) => {
  await page.goto('/#settings/connections')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Connections', level: 2, exact: true })).toBeVisible()
  await expectFitsPhone(page, 'connections')

  await main.getByRole('button', { name: 'Connection', exact: true }).tap()
  const dialog = page.getByRole('dialog', { name: 'New connection' })
  await dialog.getByLabel('Kind').selectOption('Header key')
  await dialog.getByLabel('Name', { exact: true }).fill('phone_vendor_with_a_long_name')
  await dialog.getByLabel('Hosts').fill('api.vendor-with-a-long-host-name.example')
  await expectFitsPhone(page, 'new connection')
  await dialog.getByRole('button', { name: 'Add', exact: true }).tap()
  await expect(main.getByRole('heading', { name: 'phone_vendor_with_a_long_name', level: 2 })).toBeVisible()
  await expectFitsPhone(page, 'connection')

  const values = main.getByRole('region', { name: 'Values' })
  await values.getByLabel('Key').fill(KEY)
  await values.getByRole('button', { name: 'Save' }).tap()
  await expect(values).toContainText('Set')
  await main.getByRole('switch', { name: 'phone_vendor_with_a_long_name in Default' }).tap()
  await expect(main.getByRole('switch', { name: 'phone_vendor_with_a_long_name in Default' })).toBeChecked()
  await expectFitsPhone(page, 'connection filled in')

  const overview = await apiData<CredentialsOverview>(request, '/credentials')
  expect(overview.profiles.find((profile) => profile.builtin)?.connections).toContainEqual(
    expect.objectContaining({ name: 'phone_vendor_with_a_long_name', env: 'PHONE_VENDOR_WITH_A_LONG_NAME' }),
  )
  expect(await page.content()).not.toContain(KEY)
})
