import type { AuditPage, SecretStatus } from '@seti/shared'
import { LOCAL_TOKENS } from './support/env.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'

const CLAUDE = `sk-ant-oat01-${'E2eC'.repeat(16)}`

test.describe('secrets', () => {
  test.afterEach(async ({ request }) => {
    await request.delete('/api/secrets/claude_oauth_token')
  })

  test('sets and clears the Claude token without ever showing it', async ({ page, request }) => {
    await page.goto('/#settings/credentials')
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { name: 'Credentials', level: 2 })).toBeVisible()
    const row = main.getByRole('region', { name: 'Agent tokens' })
    await expect(row).toContainText('Claude token')
    await expect(row).toContainText('Not set')

    const input = row.getByLabel('Claude token', { exact: true })
    await input.fill(CLAUDE)
    await row.getByRole('button', { name: 'Save' }).first().click()
    await expect(toasts(page).filter({ hasText: 'Claude token saved' })).toBeVisible()
    await expect(input).toHaveValue('')
    await expect(row).toContainText(/Set \d+s ago/)
    await expect(page.locator('body')).not.toContainText(CLAUDE)

    const statuses = await apiData<SecretStatus[]>(request, '/secrets')
    expect(statuses[0]).toMatchObject({ name: 'claude_oauth_token', configured: true })
    expect(JSON.stringify(statuses)).not.toContain(CLAUDE)

    await row.getByRole('button', { name: 'Clear' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Clear' }).click()
    await expect(toasts(page).filter({ hasText: 'Claude token cleared' })).toBeVisible()
    await expect(row.getByText('Not set')).toBeVisible()
    const audit = await apiData<AuditPage>(request, '/audit?kind=system.secret_cleared&limit=1')
    expect(JSON.stringify(audit)).not.toContain(CLAUDE)
  })
})

test.describe('local sign-in', () => {
  test.use({ extraHTTPHeaders: {}, allowedHttpStatuses: [401] })

  test('a loopback browser signs in with the local token', async ({ page, request }) => {
    expect((await request.get('/api/system')).status()).toBe(401)
    expect((await request.get('/api/ping')).status()).toBe(204)

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sign in to Seti' })).toBeVisible()
    const token = page.getByLabel('Local token')
    await token.fill('not-the-token-of-this-seti-at-all')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('main').getByRole('alert')).toContainText('That is not the local token of this Seti')

    await token.fill(LOCAL_TOKENS.ea)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible()

    await token.fill(LOCAL_TOKENS.user)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in to Seti' })).toHaveCount(0)
    await expect(page.getByRole('contentinfo')).toBeVisible()

    await page.reload()
    await expect(page.getByRole('contentinfo')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Sign in to Seti' })).toHaveCount(0)
  })
})
