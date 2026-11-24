import type { AuditPage, Connection } from '@seti/shared'
import { apiData, expect, test, toasts } from './support/fixtures.js'

const PASSWORD = `pw-${'L0g1n'.repeat(6)}`

test.describe('connection body swapping', () => {
  test.afterEach(async ({ request }) => {
    for (const connection of await apiData<Connection[]>(request, '/connections')) {
      await request.delete(`/api/connections/${connection.id}`)
    }
  })

  test('Body starts off, a Web login starts it on, and the user turns it on for a connection', async ({
    page,
    request,
  }) => {
    await page.goto('/#settings/connections')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'Connection', exact: true }).click()
    await page.getByRole('dialog', { name: 'Add connection' }).getByRole('button', { name: 'Custom' }).click()
    const dialog = page.getByRole('dialog', { name: 'New connection' })
    await expect(dialog.getByRole('switch', { name: 'Body' })).not.toBeChecked()
    await dialog.getByLabel('Kind').selectOption('Web login')
    await expect(dialog.getByRole('switch', { name: 'Body' })).toBeChecked()
    await expect(dialog.getByText('for logins that send the password as JSON or a form')).toBeVisible()
    await dialog.getByLabel('Name', { exact: true }).fill('e2e_site_login')
    await dialog.getByLabel('Hosts').fill('app.site.example')
    await dialog.getByLabel('Key', { exact: true }).fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(toasts(page).filter({ hasText: 'Added e2e_site_login' })).toBeVisible()
    await expect(main.getByRole('switch', { name: 'Body' })).toBeChecked()

    const settings = main.getByRole('region', { name: 'Key', exact: true })
    const saved = async () => (await apiData<Connection[]>(request, '/connections')).at(0)?.body
    await settings.getByRole('switch', { name: 'Body' }).click()
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(saved).toBe(false)
    await settings.getByRole('switch', { name: 'Body' }).click()
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(saved).toBe(true)
    const changed = await apiData<AuditPage>(request, '/audit?limit=50')
    expect(JSON.stringify(changed)).toContain('"body":true')
    expect(JSON.stringify(changed)).not.toContain(PASSWORD)
    expect(await page.content()).not.toContain(PASSWORD)
  })
})
