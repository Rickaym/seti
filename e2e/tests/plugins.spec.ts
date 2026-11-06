import type { SetiPlugin } from '@seti/shared'
import { paths, PLUGIN } from './support/env.js'
import { apiData, expect, test, waitForToastsToClear } from './support/fixtures.js'

const PROBE_TIMEOUT_MS = 60_000
const PROBING = /Starting Claude Code and waiting for MCP servers/

test('add a local plugin as a Seti default and see its skill under Skills', async ({ page, request }) => {
  test.setTimeout(PROBE_TIMEOUT_MS * 3)
  await page.goto('/#settings/plugins')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Plugins', level: 2 })).toBeVisible()

  await main.getByRole('button', { name: 'Add local plugin' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add local plugin' })
  await dialog.getByLabel('Plugin folder').fill(paths.plugin)
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeHidden()

  const row = main.getByRole('button', { name: `${PLUGIN.name} plugin` })
  await expect(row).toContainText('Seti default')
  await expect(row).toContainText('0.1.0')
  await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills' }).click()
  await expect(page).toHaveURL(/#settings\/skills$/)
  await expect(main.getByText(PROBING)).toBeHidden({ timeout: PROBE_TIMEOUT_MS })
  const skill = main.getByText(`/${PLUGIN.name}:${PLUGIN.skill}`, { exact: true })
  await expect(skill).toBeVisible({ timeout: PROBE_TIMEOUT_MS })

  const saved = await apiData<SetiPlugin[]>(request, '/plugins/defaults')
  expect(saved).toEqual([expect.objectContaining({ name: PLUGIN.name, path: paths.plugin, enabled: true })])

  await page.goto('/#settings/plugins')
  await waitForToastsToClear(page)
  await main.getByRole('button', { name: `Remove ${PLUGIN.name}` }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove Seti default' })
  await expect(confirm).toContainText(paths.plugin)
  await confirm.getByRole('button', { name: 'Remove' }).click()
  await expect(row).toBeHidden()
  await expect
    .poll(async () => (await apiData<SetiPlugin[]>(request, '/plugins/defaults')).map((plugin) => plugin.name))
    .toEqual([])
})

test.describe('invalid folders', () => {
  test.use({ allowedHttpStatuses: [400] })

  test('explains why a folder is not a plugin', async ({ page }) => {
    await page.goto('/#settings/plugins')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'Add local plugin' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add local plugin' })
    await dialog.getByLabel('Plugin folder').fill(paths.checkout)
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText(`No .claude-plugin/plugin.json in ${paths.checkout}`)).toBeVisible()
    await expect(dialog).toBeVisible()
  })
})
