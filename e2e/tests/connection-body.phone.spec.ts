import type { Connection } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.afterEach(async ({ request }) => {
  for (const connection of await apiData<Connection[]>(request, '/connections')) {
    await request.delete(`/api/connections/${connection.id}`)
  }
})

test("a connection's Body is turned on and saved on a phone", async ({ page, request }) => {
  const response = await request.post('/api/connections', {
    data: { name: 'phone_site_login', kind: 'key', env: 'PHONE_SITE_LOGIN', hosts: ['app.site.example'] },
  })
  expect(response.ok()).toBe(true)
  const made = ((await response.json()) as { data: Connection }).data
  expect(made.body).toBe(false)
  await page.goto(`/#settings/connections/${made.id}`)
  const main = page.getByRole('main')
  const body = main.getByRole('switch', { name: 'Body' })
  await expect(body).not.toBeChecked()
  await expect(main.getByText('for logins that send the password as JSON or a form')).toBeVisible()
  await expectFitsPhone(page, 'connection with Body off')
  await body.tap()
  await expect(body).toBeChecked()
  await main.getByRole('region', { name: 'Key', exact: true }).getByRole('button', { name: 'Save' }).tap()
  await expect.poll(async () => (await apiData<Connection[]>(request, '/connections')).at(0)?.body).toBe(true)
  await expectFitsPhone(page, 'connection with Body on')
})
