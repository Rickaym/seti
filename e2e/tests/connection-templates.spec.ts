import type { AuditPage, Connection } from '@seti/shared'
import { apiData, expect, test, toasts } from './support/fixtures.js'

const TENANT = '0000aaaa-11bb-22cc-33dd-444444eeeeee'
const APP = '1111bbbb-22cc-33dd-44ee-555555ffffff'
const CLIENT_SECRET = `entra-${'T3mp'.repeat(6)}`
const KEY = `xi-${'T3mp'.repeat(8)}`
const TEST_MINT = '**/api/connections/*/test'

test.describe('connection templates', () => {
  test.afterEach(async ({ request }) => {
    for (const connection of await apiData<Connection[]>(request, '/connections')) {
      await request.delete(`/api/connections/${connection.id}`)
    }
  })

  test('Microsoft Entra asks for the tenant, app and secret and adds one connection per API', async ({
    page,
    request,
  }) => {
    await page.goto('/#settings/connections')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'Connection', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Add connection' })
    await expect(picker.getByRole('button', { name: 'Stripe' })).toBeVisible()
    await expect(
      picker.getByRole('button', { name: 'Stripe' }).locator('svg[data-service-icon="stripe"]'),
    ).toBeVisible()
    await picker.getByLabel('Search services').fill('azure')
    await expect(picker.getByRole('list', { name: 'Services' }).getByRole('listitem')).toHaveCount(1)
    await expect(picker.getByRole('button', { name: 'Microsoft Entra app' }).locator('svg.lucide-cloud')).toBeVisible()
    await picker.getByRole('button', { name: 'Microsoft Entra app' }).click()

    const form = page.getByRole('dialog', { name: 'Microsoft Entra app' })
    const add = form.getByRole('button', { name: 'Add', exact: true })
    await expect(add).toBeDisabled()
    await expect(form.getByText('Enter the Directory (tenant) ID to add it.')).toBeVisible()
    await expect(form.locator('.text-destructive')).toHaveCount(0)
    await form.getByLabel('Directory (tenant) ID').fill(TENANT)
    await form.getByLabel('Application (client) ID').fill(APP)
    await form.getByLabel('Client secret').fill(CLIENT_SECRET)
    await expect(form.getByLabel('Client secret')).toHaveAttribute('type', 'password')
    await expect(form.getByText('Pick at least one API to add it.')).toBeVisible()
    await form.getByRole('switch', { name: 'Microsoft Graph' }).click()
    await form.getByRole('switch', { name: 'Azure Resource Manager' }).click()
    const adds = form.getByRole('list', { name: 'Adds' })
    await expect(adds.getByRole('listitem')).toHaveCount(2)
    await expect(adds).toContainText('entra_graph')
    await expect(adds).toContainText('management.azure.com - ENTRA_ARM')
    await form.getByRole('switch', { name: 'Microsoft Entra app in Default' }).click()
    await add.click()

    const result = page.getByRole('dialog', { name: 'Microsoft Entra app added' })
    const graph = result.getByRole('listitem', { name: 'entra_graph' })
    await expect(graph).toContainText('graph.microsoft.com - ENTRA_GRAPH')
    await expect(graph).toContainText('In Default.')
    await expect(result.getByRole('listitem', { name: 'entra_arm' })).toContainText('management.azure.com')
    const granted = { ok: true, error: null, expires_at: null, scope: null, token_type: 'Bearer' }
    await page.route(TEST_MINT, async (route) => route.fulfill({ json: { data: granted, meta: {} } }))
    await graph.getByRole('button', { name: 'Test' }).click()
    await expect(toasts(page).filter({ hasText: 'Minted a token' })).toBeVisible()
    await page.unroute(TEST_MINT)
    expect(await page.content()).not.toContain(CLIENT_SECRET)
    await result.getByRole('button', { name: 'Done' }).click()

    const rows = main.getByRole('list', { name: 'Connections' })
    await expect(rows.getByRole('listitem', { name: 'entra_graph' })).toContainText('graph.microsoft.com - In Default')
    await expect(rows.getByRole('listitem', { name: 'entra_arm' })).toContainText('management.azure.com - In Default')
    const made = await apiData<Connection[]>(request, '/connections')
    expect(made.map((connection) => [connection.name, connection.missing, connection.mint?.scope])).toEqual([
      ['entra_arm', [], 'https://management.azure.com/.default'],
      ['entra_graph', [], 'https://graph.microsoft.com/.default'],
    ])
    expect(made[0]?.mint).toMatchObject({
      token_url: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      client_id: APP,
    })
    const audit = JSON.stringify(await apiData<AuditPage>(request, '/audit?limit=50'))
    expect(audit).toContain('from the template microsoft_entra')
    expect(audit).not.toContain(CLIENT_SECRET)
  })

  test('an API key service asks only for its key and opens its page', async ({ page, request }) => {
    await page.goto('/#settings/connections')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'Connection', exact: true }).click()
    await page.getByRole('dialog', { name: 'Add connection' }).getByRole('button', { name: 'ElevenLabs' }).click()
    const form = page.getByRole('dialog', { name: 'ElevenLabs' })
    await expect(form.getByRole('list', { name: 'Adds' })).toContainText('api.elevenlabs.io - ELEVENLABS_API_KEY')
    await expect(form.getByLabel('Hosts')).toHaveCount(0)
    await form.getByLabel('API key').fill(KEY)
    await form.getByRole('button', { name: 'Add', exact: true }).click()
    const result = page.getByRole('dialog', { name: 'ElevenLabs added' })
    await expect(result.getByRole('listitem', { name: 'elevenlabs' })).toContainText('In no credential yet')
    await expect(result.getByRole('button', { name: 'Test' })).toHaveCount(0)
    await result.getByRole('button', { name: 'Open elevenlabs' }).click()
    await expect(main.getByRole('heading', { name: 'elevenlabs', level: 2 })).toBeVisible()
    await expect(main.getByRole('region', { name: 'Values' })).toContainText('Set')
    await expect(main.getByLabel('Header', { exact: true })).toHaveValue('xi-api-key')
    expect(await page.content()).not.toContain(KEY)
    const [made] = await apiData<Connection[]>(request, '/connections')
    expect(made).toMatchObject({ header: { name: 'xi-api-key', template: '{{value}}' }, missing: [] })
  })

  test('a Google API reads only until its Write switch is on', async ({ page, request }) => {
    await page.goto('/#settings/connections')
    await page.getByRole('main').getByRole('button', { name: 'Connection', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Add connection' })
    await picker.getByRole('button', { name: 'Google service account' }).click()
    const form = page.getByRole('dialog', { name: 'Google service account' })
    await expect(form.getByRole('switch', { name: 'Gmail write' })).toHaveCount(0)
    await form.getByRole('switch', { name: 'Gmail', exact: true }).click()
    await form.getByRole('switch', { name: 'Drive', exact: true }).click()
    await expect(form.getByRole('switch', { name: 'Gmail write' })).not.toBeChecked()
    await form.getByRole('switch', { name: 'Drive write' }).click()
    await expect(form.getByRole('list', { name: 'Adds' })).toContainText(
      'gmail.googleapis.com, www.googleapis.com - GOOGLE_ACCESS_TOKEN',
    )
    await form.getByRole('button', { name: 'Add', exact: true }).click()
    const result = page.getByRole('dialog', { name: 'Google service account added' })
    await expect(result.getByRole('listitem', { name: 'google' })).toContainText('Needs key file')
    await expect(result.locator('.text-destructive')).toHaveCount(0)
    const [made] = await apiData<Connection[]>(request, '/connections')
    expect(made?.mint?.scope).toBe(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive',
    )
  })

  test('Custom keeps the form with every field, and a search with no match points to it', async ({ page }) => {
    await page.goto('/#settings/connections')
    await page.getByRole('main').getByRole('button', { name: 'Connection', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Add connection' })
    await picker.getByLabel('Search services').fill('no such vendor')
    await expect(picker.getByText('Nothing matches. Add it as a custom connection.')).toBeVisible()
    await picker.getByRole('button', { name: 'Custom' }).click()
    const dialog = page.getByRole('dialog', { name: 'New connection' })
    await expect(dialog.getByLabel('Kind')).toHaveValue('API key')
    await expect(dialog.getByLabel('Hosts')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(picker.getByLabel('Search services')).toBeVisible()
  })
})
