import type { APIRequestContext } from '@playwright/test'
import type { CredentialProfile } from '@seti/shared'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

async function create(request: APIRequestContext, name: string): Promise<CredentialProfile> {
  const response = await request.post('/api/credentials/profiles', { data: { name } })
  return ((await response.json()) as { data: CredentialProfile }).data
}

test("a credential's access fits a phone, switches, hosts and all", async ({ page, request }) => {
  const profile = await create(request, unique('Payments with a long name'))
  await page.goto(`/#settings/credentials/${profile.id}`)
  const access = page.getByRole('main').getByRole('region', { name: 'Access' })
  await access.getByRole('switch', { name: 'AWS', exact: true }).tap()
  await expect(access.getByRole('switch', { name: 'AWS', exact: true })).toBeChecked()
  const hosts = access.getByRole('region', { name: 'Hosts' })
  await hosts.getByLabel('Host to add').fill('api.a-rather-long-payments-host.example')
  await hosts.getByRole('button', { name: 'Add' }).tap()
  await expect(hosts).toContainText('api.a-rather-long-payments-host.example')
  await access.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'credential access')
  await expectTouchTarget(hosts.getByRole('button', { name: 'Remove api.a-rather-long-payments-host.example' }))
  await page.screenshot({ path: test.info().outputPath('credential-access-phone.png'), fullPage: true })
  await request.delete(`/api/credentials/profiles/${profile.id}`)
})
