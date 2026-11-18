import type { Connection } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const TENANT = '0000aaaa-11bb-22cc-33dd-444444eeeeee'
const APP = '1111bbbb-22cc-33dd-44ee-555555ffffff'
const CLIENT_SECRET = `entra-${'Ph0n'.repeat(6)}`

test.afterEach(async ({ request }) => {
  for (const connection of await apiData<Connection[]>(request, '/connections')) {
    await request.delete(`/api/connections/${connection.id}`)
  }
})

test('a service is picked by name, filled in and added on a phone', async ({ page, request }) => {
  await page.goto('/#settings/connections')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Connection', exact: true }).tap()
  const picker = page.getByRole('dialog', { name: 'Add connection' })
  await expect(picker.getByRole('button', { name: 'Custom' })).toBeVisible()
  await expectFitsPhone(page, 'service picker')
  const stripe = picker.getByRole('button', { name: 'Stripe' })
  await expect(stripe.locator('svg[data-service-icon="stripe"]')).toBeVisible()
  expect((await stripe.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await picker.getByLabel('Search services').fill('entra')
  await expect(picker.getByRole('button', { name: 'Microsoft Entra app' }).locator('svg.lucide-cloud')).toBeVisible()
  await picker.getByRole('button', { name: 'Microsoft Entra app' }).tap()

  const form = page.getByRole('dialog', { name: 'Microsoft Entra app' })
  await form.getByLabel('Directory (tenant) ID').fill(TENANT)
  await form.getByLabel('Application (client) ID').fill(APP)
  await form.getByLabel('Client secret').fill(CLIENT_SECRET)
  await form.getByRole('switch', { name: 'Microsoft Graph' }).tap()
  await form.getByRole('switch', { name: 'Azure Storage' }).tap()
  await expect(form.getByRole('list', { name: 'Adds' }).getByRole('listitem')).toHaveCount(2)
  await expectFitsPhone(page, 'service form')
  await form.getByRole('button', { name: 'Add', exact: true }).tap()

  const result = page.getByRole('dialog', { name: 'Microsoft Entra app added' })
  await expect(result.getByRole('listitem', { name: 'entra_storage' })).toContainText('*.blob.core.windows.net')
  await expectFitsPhone(page, 'service added')
  expect(await page.content()).not.toContain(CLIENT_SECRET)
  await result.getByRole('button', { name: 'Open entra_graph' }).tap()
  await expect(main.getByRole('heading', { name: 'entra_graph', level: 2 })).toBeVisible()
  await expectFitsPhone(page, 'connection from a service')

  const made = await apiData<Connection[]>(request, '/connections')
  expect(made.map((connection) => connection.name)).toEqual(['entra_graph', 'entra_storage'])
})

test('Custom is one tap from the picker on a phone', async ({ page }) => {
  await page.goto('/#settings/connections')
  await page.getByRole('main').getByRole('button', { name: 'Connection', exact: true }).tap()
  await page.getByRole('dialog', { name: 'Add connection' }).getByRole('button', { name: 'Custom' }).tap()
  await expect(page.getByRole('dialog', { name: 'New connection' }).getByLabel('Kind')).toHaveValue('API key')
})
