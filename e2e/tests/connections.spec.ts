import type { AuditPage, Connection, CredentialsOverview } from '@seti/shared'
import { apiData, expect, test, toasts } from './support/fixtures.js'

const KEY = `xi-${'V01c'.repeat(8)}`
const CLIENT_SECRET = `entra-${'S3cr'.repeat(6)}`
const TEST_MINT = '**/api/connections/*/test'

test.describe('connections', () => {
  test.use({ allowedHttpStatuses: [400, 409] })

  test.afterEach(async ({ request }) => {
    for (const connection of await apiData<Connection[]>(request, '/connections')) {
      await request.delete(`/api/connections/${connection.id}`)
    }
  })

  test('New connection adds a key with its value and credential in one step and never shows it', async ({
    page,
    request,
  }) => {
    await page.goto('/#settings/connections')
    const main = page.getByRole('main')
    await expect(main.getByText('No connections yet.')).toBeVisible()
    await main.getByRole('button', { name: 'Connection', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New connection' })
    await expect(dialog.getByLabel('Kind')).toHaveValue('API key')
    await dialog.getByLabel('Name', { exact: true }).fill('e2e_voice')
    await expect(dialog.getByLabel('Variable')).toHaveValue('E2E_VOICE')
    await dialog.getByLabel('Hosts').fill('api.voice.example, *.voice-cdn.example')
    await dialog.getByLabel('Key', { exact: true }).fill(KEY)
    await expect(dialog.getByLabel('Key', { exact: true })).toHaveAttribute('type', 'password')
    const inDefault = dialog.getByRole('switch', { name: 'e2e_voice in Default' })
    await expect(inDefault).not.toBeChecked()
    await inDefault.click()
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(toasts(page).filter({ hasText: 'Added e2e_voice' })).toBeVisible()
    await expect(page).toHaveURL(/#settings\/connections\/[\w-]+$/)
    await expect(main.getByRole('heading', { name: 'e2e_voice', level: 2 })).toBeVisible()
    await expect(main.getByRole('region', { name: 'Values' })).toContainText('Set')
    await expect(main.getByRole('switch', { name: 'e2e_voice in Default' })).toBeChecked()

    const overview = await apiData<CredentialsOverview>(request, '/credentials')
    expect(overview.profiles.find((profile) => profile.builtin)?.connections).toContainEqual(
      expect.objectContaining({
        name: 'e2e_voice',
        env: 'E2E_VOICE',
        hosts: ['api.voice.example', '*.voice-cdn.example'],
      }),
    )
    expect(await page.content()).not.toContain(KEY)
    const audit = await apiData<AuditPage>(request, '/audit?limit=50')
    expect(JSON.stringify(audit)).not.toContain(KEY)

    await main.getByRole('button', { name: 'Back to connections' }).click()
    const row = main.getByRole('list', { name: 'Connections' }).getByRole('listitem', { name: 'e2e_voice' })
    await expect(row).toContainText('In Default')
  })

  test('an OAuth connection says what it needs, takes values write-only and tests a mint', async ({ page }) => {
    await page.goto('/#settings/connections')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'Connection', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New connection' })
    await dialog.getByLabel('Kind').selectOption('Entra ID app')
    await expect(dialog.getByLabel('Scope')).toHaveValue('https://graph.microsoft.com/.default')
    await expect(dialog.getByRole('switch', { name: 'Seti adds it' })).toBeChecked()
    await dialog.getByLabel('Name', { exact: true }).fill('e2e_graph')
    await dialog.getByLabel('Token URL').fill('https://127.0.0.1:9/token')
    await dialog.getByLabel('Client ID', { exact: true }).fill('e2e-client')
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(main.getByRole('heading', { name: 'e2e_graph', level: 2 })).toBeVisible()

    const values = main.getByRole('region', { name: 'Values' })
    await expect(values).toContainText('Not set')
    await values.getByLabel('Client secret').fill(CLIENT_SECRET)
    await values.getByRole('button', { name: 'Save' }).click()
    await expect(toasts(page).filter({ hasText: 'Client secret saved' })).toBeVisible()
    await expect(values.getByLabel('Client secret')).toHaveValue('')

    const granted = { ok: true, error: null, expires_at: null, scope: 'Mail.Read', token_type: 'Bearer' }
    await page.route(TEST_MINT, async (route) => route.fulfill({ json: { data: granted, meta: {} } }))
    await main.getByRole('button', { name: 'Test' }).click()
    await expect(toasts(page).filter({ hasText: 'Minted a token' })).toBeVisible()
    await page.unroute(TEST_MINT)
    await main.getByRole('button', { name: 'Test' }).click()
    await expect(
      toasts(page).filter({ hasText: 'Minting failed: the token endpoint could not be reached' }),
    ).toBeVisible()

    await main.getByRole('button', { name: 'Back to connections' }).click()
    const row = main.getByRole('list', { name: 'Connections' }).getByRole('listitem', { name: 'e2e_graph' })
    await expect(row).toContainText('In no credential')
    await expect(row).toContainText('Mint failed: the token endpoint could not be reached')
    expect(await page.content()).not.toContain(CLIENT_SECRET)
  })

  test('a signed JWT needs a private key and an issuer, and a Google key file needs only the file', async ({
    page,
  }) => {
    await page.goto('/#settings/connections')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'Connection', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New connection' })
    await dialog.getByLabel('Kind').selectOption('Google key file')
    await expect(dialog.getByLabel('Key file')).toBeVisible()
    await expect(dialog.getByLabel('Private key')).toHaveCount(0)
    await dialog.getByLabel('Kind').selectOption('Signed JWT')
    await dialog.getByLabel('Name', { exact: true }).fill('e2e_salesforce')
    await dialog.getByLabel('Hosts').fill('example.my.salesforce.test')
    await dialog.getByLabel('Token URL').fill('https://login.salesforce.test/services/oauth2/token')
    await dialog.getByLabel('Issuer').fill('connected-app-id')
    await expect(dialog.getByLabel('Private key')).toBeVisible()
    await expect(dialog.getByLabel('Key file')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(main.getByRole('heading', { name: 'e2e_salesforce', level: 2 })).toBeVisible()
    await expect(main.getByRole('region', { name: 'Signed JWT' })).toBeVisible()
    await main.getByRole('button', { name: 'Back to connections' }).click()
    const row = main.getByRole('list', { name: 'Connections' }).getByRole('listitem', { name: 'e2e_salesforce' })
    await expect(row).toContainText('Needs private key')
  })

  test('a connection without its value says what it needs, not as an error, and deletes after a confirm', async ({
    page,
    request,
  }) => {
    const response = await request.post('/api/connections', {
      data: { name: 'e2e_pending', kind: 'key', env: 'E2E_PENDING', hosts: ['ci.vendor.example'] },
    })
    const made = ((await response.json()) as { data: Connection }).data
    await page.goto('/#settings/connections')
    const main = page.getByRole('main')
    const row = main.getByRole('list', { name: 'Connections' }).getByRole('listitem', { name: 'e2e_pending' })
    await expect(row).toContainText('Needs key')
    await expect(row.locator('.text-destructive')).toHaveCount(0)
    await row.getByRole('button', { name: 'e2e_pending' }).click()
    await main.getByRole('button', { name: 'Delete', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: 'Delete e2e_pending' })
    await expect(confirm).toContainText('No credential carries it. Its values are deleted.')
    await confirm.getByRole('button', { name: 'Delete' }).click()
    await expect(toasts(page).filter({ hasText: 'Deleted e2e_pending' })).toBeVisible()
    await expect(page).toHaveURL(/#settings\/connections$/)
    expect((await request.get(`/api/connections/${made.id}`)).status()).toBe(404)
  })
})
