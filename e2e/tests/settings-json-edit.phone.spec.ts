import type { Page } from '@playwright/test'
import type { SettingsDoc } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { editedText, typeSettings } from './support/settings-json.js'

const main = (page: Page) => page.getByRole('main')

test('a phone edits a plain setting as JSON through the preview', async ({ page, request }) => {
  const ea = async () =>
    ((await apiData<SettingsDoc>(request, '/settings-doc')).app as { ea: { wake_phrase: string } }).ea.wake_phrase
  const was = await ea()
  await page.goto('/#settings/json')
  await main(page).getByRole('button', { name: 'Edit' }).tap()
  await expectFitsPhone(page, 'settings JSON editor')
  await typeSettings(page, await editedText(request, { app: { ea: { wake_phrase: 'Hey Phone' } } }), true)
  await main(page).getByRole('button', { name: 'Save' }).tap()
  const preview = page.getByRole('dialog', { name: 'Save 1 change' })
  await expect(preview).toContainText('app.ea.wake_phrase')
  await expectFitsPhone(page, 'settings JSON preview')
  await preview.getByRole('button', { name: 'Save' }).tap()
  await expect.poll(ea).toBe('Hey Phone')
  await request.patch('/api/settings-doc', {
    data: {
      base_revision: (await apiData<SettingsDoc>(request, '/settings-doc')).revision,
      patch: { app: { ea: { wake_phrase: was } } },
    },
  })
})
