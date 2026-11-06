import type { AuditPage, PasskeyInfo } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { onLocalhost, setupCode, virtualAuthenticator } from './support/setup-code.js'

test.describe('passkey sign-in', () => {
  test.use({ extraHTTPHeaders: {}, allowedHttpStatuses: [401] })

  test('enrolls with a setup code from the host, then signs in with the passkey', async ({
    page,
    context,
    baseURL,
  }) => {
    test.slow(true, 'The setup-code CLI starts its own tsx process')
    await virtualAuthenticator(context, page)
    const home = onLocalhost(baseURL ?? '')
    await page.goto(`${home}/`)
    await expect(page.getByRole('heading', { name: 'Sign in to Seti' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Passkey' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Setup code' }).click()
    await page.getByLabel('Setup code').fill(setupCode().toLowerCase())
    await page.getByRole('button', { name: 'Add passkey' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in to Seti' })).toHaveCount(0)
    await expect(page.getByRole('contentinfo')).toBeVisible()

    await context.clearCookies()
    await page.reload()
    await page.getByRole('button', { name: 'Passkey' }).click()
    await expect(page.getByRole('contentinfo')).toBeVisible()
    await page.reload()
    await expect(page.getByRole('contentinfo')).toBeVisible()

    await page.goto(`${home}/#settings/signin`)
    const sessions = page.getByRole('region', { name: 'Browsers' })
    await expect(sessions.getByTestId('auth-session').filter({ hasText: 'This browser' })).toHaveCount(1)
    await sessions
      .getByTestId('auth-session')
      .filter({ hasText: 'This browser' })
      .getByRole('button', { name: 'Sign out' })
      .click()
    await expect(page.getByRole('heading', { name: 'Sign in to Seti' })).toBeVisible()
  })
})

test.describe('passkey settings', () => {
  test('adds, renames and removes a passkey', async ({ page, context, baseURL, request }) => {
    await virtualAuthenticator(context, page)
    await page.goto(`${onLocalhost(baseURL ?? '')}/#settings/signin`)
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { name: 'Sign-in', level: 2 })).toBeVisible()
    await expect(main.getByRole('switch', { name: 'Require passkey' })).toBeDisabled()

    const passkeys = main.getByRole('region', { name: 'Passkeys' })
    const before = (await apiData<PasskeyInfo[]>(request, '/auth/passkeys')).length
    await passkeys.getByRole('button', { name: 'Add' }).click()
    const rows = passkeys.getByTestId('passkey')
    await expect(rows).toHaveCount(before + 1)
    const added = rows.last()
    await expect(added).toContainText('localhost')

    await added.getByRole('button', { name: 'Rename' }).click()
    await added.getByRole('textbox').fill('Desk key')
    await added.getByRole('button', { name: 'Save' }).click()
    await expect(passkeys.getByText('Desk key')).toBeVisible()

    await passkeys
      .getByTestId('passkey')
      .filter({ hasText: 'Desk key' })
      .getByRole('button', { name: 'Remove' })
      .click()
    const removed = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' && new URL(response.url()).pathname.startsWith('/api/auth/passkeys/'),
    )
    const confirm = page.getByRole('dialog')
    await confirm.getByRole('button', { name: 'Remove' }).click()
    expect((await removed).ok()).toBe(true)
    await expect(confirm).toBeHidden()
    await expect(passkeys.getByText('Desk key')).toHaveCount(0)
    const audit = await apiData<AuditPage>(request, '/audit?kind=system.passkey_removed&limit=1')
    expect(JSON.stringify(audit)).toContain('Desk key')
  })
})
