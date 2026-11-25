import fs from 'node:fs'
import type { Page } from '@playwright/test'
import type { SettingsDoc } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'

const main = (page: Page) => page.getByRole('main')
const section = (page: Page, path: string) => main(page).getByRole('region', { name: path, exact: true })
const clipboard = async (page: Page) => page.evaluate(async () => navigator.clipboard.readText())

test('the JSON page shows every setting, finds a key and copies a section', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/#settings')
  await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'JSON' }).click()
  await expect(main(page).getByRole('heading', { name: 'JSON', level: 2, exact: true })).toBeVisible()
  for (const path of ['app.general', 'agents.lifecycle', 'security.sandbox', 'security.connections']) {
    await expect(section(page, path)).toBeVisible()
  }

  await main(page).getByRole('textbox', { name: 'Search settings' }).fill('wake_phrase')
  await expect(section(page, 'app.ea')).toContainText('"wake_phrase"')
  await expect(section(page, 'app.ea')).not.toContainText('keep_awake_seconds')
  await expect(section(page, 'security.sandbox')).toBeHidden()

  await section(page, 'app.ea').getByRole('button', { name: 'Copy app.ea' }).click()
  await expect.poll(async () => JSON.parse(await clipboard(page)) as unknown).toEqual({ wake_phrase: 'Hey Seti' })

  await main(page).getByRole('textbox', { name: 'Search settings' }).fill('')
  await main(page).getByRole('combobox', { name: 'Group' }).click()
  await page.getByRole('option', { name: 'Security' }).click()
  await expect(section(page, 'security.sandbox')).toBeVisible()
  await expect(section(page, 'app.general')).toBeHidden()
})

test('export saves the whole document as the API serves it', async ({ page, request }) => {
  await page.goto('/#settings/json')
  const download = page.waitForEvent('download')
  await main(page).getByRole('button', { name: 'Export' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^seti-settings-\d{4}-\d{2}-\d{2}\.json$/)
  const saved = JSON.parse(fs.readFileSync(await file.path(), 'utf8')) as SettingsDoc
  const served = await apiData<SettingsDoc>(request, '/settings-doc')
  expect(saved.version).toBe(1)
  expect(saved.revision).toBe(served.revision)
})

test('marks settings that differ from their default and opens a page as JSON', async ({ page, request }) => {
  const dreams = await apiData<{ at_once: number }>(request, '/dreams/settings')
  await request.put('/api/dreams/settings', { data: { at_once: dreams.at_once === 2 ? 3 : 2 } })
  try {
    await page.goto('/#settings/agents')
    await main(page).getByRole('button', { name: 'Open as JSON' }).click()
    await expect(main(page).getByRole('heading', { name: 'JSON', level: 2, exact: true })).toBeVisible()
    await expect(section(page, 'agents.lifecycle')).toBeInViewport()
    await expect(section(page, 'agents.lifecycle')).toContainText(' modified')

    await main(page).getByRole('button', { name: 'Modified' }).click()
    await expect(section(page, 'agents.lifecycle')).toContainText('"at_once"')
    await expect(section(page, 'agents.lifecycle')).not.toContainText('"window_start"')
  } finally {
    await request.put('/api/dreams/settings', { data: { at_once: dreams.at_once } })
  }
})
