import type { Page } from '@playwright/test'
import type { SettingsDoc } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { editedText, typeSettings } from './support/settings-json.js'

const main = (page: Page) => page.getByRole('main')
const section = (page: Page, path: string) => main(page).getByRole('region', { name: path, exact: true })

const awake = async (request: Parameters<typeof apiData>[0]) =>
  ((await apiData<SettingsDoc>(request, '/settings-doc')).app as { ea: { keep_awake_seconds: number } }).ea
    .keep_awake_seconds

test('edits a plain setting as JSON with a preview, then undoes it from the history', async ({ page, request }) => {
  const was = await awake(request)
  const next = was === 31 ? 32 : 31
  await page.goto('/#settings/json')
  await main(page).getByRole('button', { name: 'Edit' }).click()
  await typeSettings(page, await editedText(request, { app: { ea: { keep_awake_seconds: next } } }))
  await main(page).getByRole('button', { name: 'Save' }).click()

  const preview = page.getByRole('dialog', { name: 'Save 1 change' })
  await expect(preview.getByRole('list', { name: 'Changes' })).toContainText('app.ea.keep_awake_seconds')
  await preview.getByRole('button', { name: 'Save' }).click()
  await expect(preview).toBeHidden()
  await expect(section(page, 'app.ea')).toContainText(`"keep_awake_seconds": ${String(next)}`)
  expect(await awake(request)).toBe(next)

  const history = section(page, 'History')
  await history
    .getByRole('button', { name: /^Revert revision/ })
    .first()
    .click()
  await page.getByRole('dialog', { name: 'Revert change' }).getByRole('button', { name: 'Revert' }).click()
  await expect.poll(async () => awake(request)).toBe(was)
})

test('names the line of an invalid setting and a security setting, changing nothing', async ({ page, request }) => {
  const before = await apiData<SettingsDoc>(request, '/settings-doc')
  await page.goto('/#settings/json')
  await main(page).getByRole('button', { name: 'Edit' }).click()
  await typeSettings(page, await editedText(request, { app: { ea: { keep_awake_seconds: 'soon' } } }))
  await main(page).getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog', { name: 'Save 1 change' }).getByRole('button', { name: 'Save' }).click()
  const problems = main(page).getByRole('alert', { name: 'Problems' })
  await expect(problems).toContainText('app.ea.keep_awake_seconds')
  await expect(problems).toContainText(/Line \d+/)

  await typeSettings(page, await editedText(request, { security: { sandbox: { enabled: false } } }))
  await main(page).getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog', { name: 'Save 1 change' }).getByRole('button', { name: 'Save' }).click()
  await expect(problems).toContainText('security setting')
  await expect(problems.getByRole('button', { name: 'Open page' })).toBeVisible()
  expect((await apiData<SettingsDoc>(request, '/settings-doc')).revision).toBe(before.revision)
})
