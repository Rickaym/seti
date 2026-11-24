import type { Page } from '@playwright/test'
import type { SettingsDoc } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const main = (page: Page) => page.getByRole('main')

test('a phone imports a settings file through the preview', async ({ page, request }) => {
  const phrase = async () =>
    ((await apiData<SettingsDoc>(request, '/settings-doc')).app as { ea: { wake_phrase: string } }).ea.wake_phrase
  const was = await phrase()
  const file = { app: { ea: { wake_phrase: 'Hey Import' } }, security: { sharing: { enabled: true } } }
  await page.goto('/#settings/json')
  await main(page)
    .getByLabel('Settings file')
    .setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) })
  const dialog = page.getByRole('dialog', { name: 'Import settings' })
  await expect(dialog.getByRole('region', { name: 'Not imported' })).toContainText('security.sharing.enabled')
  await expectFitsPhone(page, 'settings import preview')
  await dialog.getByRole('button', { name: 'Import' }).tap()
  await expect.poll(phrase).toBe('Hey Import')
  const doc = await apiData<SettingsDoc>(request, '/settings-doc')
  await request.patch('/api/settings-doc', {
    data: { base_revision: doc.revision, patch: { app: { ea: { wake_phrase: was } } } },
  })
})
