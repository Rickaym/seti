import { generateKeyPairSync } from 'node:crypto'
import type { AuditPage } from '@seti/shared'
import { apiData, expect, test, toasts } from './support/fixtures.js'

test('pairs a phone from its code, then renames and revokes it', async ({ page, request }) => {
  await page.goto('/#settings/signin')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Sign-in', level: 2 })).toBeVisible()
  const phones = main.getByRole('region', { name: 'Phones' })
  await phones.getByRole('button', { name: 'Pair phone' }).click()

  const dialog = page.getByRole('dialog', { name: 'Pair phone' })
  await expect(dialog.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
  const code = (await dialog.getByTestId('pairing-code').textContent()) ?? ''
  expect(code).toMatch(/^[\w-]{22}$/)

  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey
  const paired = await request.post('/api/devices/pair', {
    headers: { authorization: '' },
    data: {
      code,
      name: 'Test phone',
      platform: 'android',
      public_key: key.export({ type: 'spki', format: 'der' }).toString('base64url'),
    },
  })
  expect(paired.ok()).toBe(true)
  await expect(toasts(page).filter({ hasText: 'Paired Test phone' })).toBeVisible()
  await expect(dialog).toHaveCount(0)

  const row = phones.getByTestId('device').filter({ hasText: 'Test phone' })
  await expect(row).toContainText('android, widget')
  await row.getByRole('button', { name: 'Rename' }).click()
  await phones.getByRole('textbox', { name: 'New name for Test phone' }).fill('Pocket')
  await phones.getByRole('button', { name: 'Save' }).click()
  const renamed = phones.getByTestId('device').filter({ hasText: 'Pocket' })
  await expect(renamed).toBeVisible()

  await renamed.getByRole('button', { name: 'Revoke' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click()
  await expect(phones.getByTestId('device')).toHaveCount(0)
  await expect
    .poll(async () => JSON.stringify(await apiData<AuditPage>(request, '/audit?kind=system.device_revoked&limit=1')))
    .toContain('Pocket')
})
