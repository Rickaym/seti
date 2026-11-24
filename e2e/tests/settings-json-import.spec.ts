import fs from 'node:fs'
import type { Page } from '@playwright/test'
import type { SettingsDoc } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'

const main = (page: Page) => page.getByRole('main')

const awake = async (request: Parameters<typeof apiData>[0]) =>
  ((await apiData<SettingsDoc>(request, '/settings-doc')).app as { ea: { keep_awake_seconds: number } }).ea
    .keep_awake_seconds

test('exports only modified settings when Modified is on', async ({ page }) => {
  await page.goto('/#settings/json')
  await main(page).getByRole('button', { name: 'Modified' }).click()
  const download = page.waitForEvent('download')
  await main(page).getByRole('button', { name: 'Export' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^seti-settings-modified-\d{4}-\d{2}-\d{2}\.json$/)
  const saved = JSON.parse(fs.readFileSync(await file.path(), 'utf8')) as SettingsDoc
  expect(saved.version).toBe(1)
})

test('imports a file after a preview that skips security and offers servers one by one', async ({ page, request }) => {
  const was = await awake(request)
  const next = was === 33 ? 34 : 33
  const file = {
    version: 1,
    app: { ea: { keep_awake_seconds: next } },
    capabilities: { mcp_servers: { defaults: { 'imported server': true } } },
    security: { sandbox: { enabled: false } },
  }
  await page.goto('/#settings/json')
  await main(page)
    .getByLabel('Settings file')
    .setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) })
  const dialog = page.getByRole('dialog', { name: 'Import settings' })
  await expect(dialog.getByRole('region', { name: 'Changes' })).toContainText('app.ea.keep_awake_seconds')
  await expect(dialog.getByRole('region', { name: 'Confirm each' })).toContainText('imported server')
  await expect(dialog.getByRole('region', { name: 'Not imported' })).toContainText('security.sandbox.enabled')
  await dialog.getByRole('button', { name: 'Import' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => awake(request)).toBe(next)
  const doc = await apiData<SettingsDoc>(request, '/settings-doc')
  expect(JSON.stringify(doc)).not.toContain('imported server')
  expect((doc.security as { sandbox: { enabled: boolean } }).sandbox.enabled).toBe(true)
  await request.patch('/api/settings-doc', {
    data: { base_revision: doc.revision, patch: { app: { ea: { keep_awake_seconds: was } } } },
  })
})
