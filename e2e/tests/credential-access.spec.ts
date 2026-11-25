import type { APIRequestContext } from '@playwright/test'
import type { CredentialProfile } from '@seti/shared'
import { expect, test, unique } from './support/fixtures.js'

async function create(request: APIRequestContext, name: string): Promise<CredentialProfile> {
  const response = await request.post('/api/credentials/profiles', { data: { name } })
  return ((await response.json()) as { data: CredentialProfile }).data
}

test("a credential's access: an item its agents follow, back to the default, and a host", async ({ page, request }) => {
  const profile = await create(request, unique('Payments'))
  await page.goto(`/#settings/credentials/${profile.id}`)
  const access = page.getByRole('main').getByRole('region', { name: 'Access' })
  const aws = access.getByRole('listitem').filter({ has: page.getByRole('switch', { name: 'AWS', exact: true }) })
  await expect(aws).toContainText('Inherited')

  await access.getByRole('switch', { name: 'AWS', exact: true }).click()
  await expect(page.getByText(`Agents using ${profile.name} follow it from their next turn`)).toBeVisible()
  await expect(aws).toContainText('Custom')
  await expect(access.getByRole('switch', { name: 'AWS', exact: true })).toBeChecked()
  await access.getByRole('button', { name: 'Reset AWS' }).click()
  await expect(aws).toContainText('Inherited')
  await expect(access.getByRole('switch', { name: 'AWS', exact: true })).not.toBeChecked()

  const hosts = access.getByRole('region', { name: 'Hosts' })
  await hosts.getByLabel('Host to add').fill('api.payments.example')
  await hosts.getByRole('button', { name: 'Add' }).click()
  await expect(hosts).toContainText('api.payments.example')
  await page.screenshot({ path: test.info().outputPath('credential-access.png'), fullPage: true })
  await hosts.getByRole('button', { name: 'Remove api.payments.example' }).click()
  await expect(hosts).not.toContainText('api.payments.example')
  await request.delete(`/api/credentials/profiles/${profile.id}`)
})
