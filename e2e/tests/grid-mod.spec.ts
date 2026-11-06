import type { Page } from '@playwright/test'
import type { WorkspaceEntry, WorkspaceGrid } from '@seti/shared'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { grid, panelOf, startAgent } from './support/grid.js'
import { setModEnabled } from './support/mods.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search Seti' })
const guide = (page: Page) => page.getByRole('dialog', { name: 'Shortcuts' })

test.afterEach(async ({ request }) => {
  await setModEnabled(request, 'grid', true)
})

test('with the grid mod off, every way into the grid is gone and its layout waits', async ({ page, request }) => {
  const title = `Grid off ${String(Date.now())}`
  const id = await startAgent(request, title)
  const [main] = await apiData<WorkspaceEntry[]>(request, '/workspaces')
  const layout = { panels: [{ i: 'p1', agent: id, x: 0, y: 0, w: 12, h: 24 }], locked: false }
  expect((await request.put(`/api/mods/grid/layouts/${main?.id ?? ''}`, { data: { layout } })).ok()).toBe(true)
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  await expect(panelOf(page, title)).toHaveCount(1)

  await setModEnabled(request, 'grid', false)
  await page.goto(`/#agents/${id}`)
  await page.reload()
  await expect(page.getByRole('main').getByRole('heading', { name: title })).toBeVisible()
  await expect(grid(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Grid', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open in grid' })).toHaveCount(0)
  await page.keyboard.press('Alt+g')
  await expect(grid(page)).toHaveCount(0)
  expect((await request.get('/api/mods/grid/layouts')).status()).toBe(404)

  await page.keyboard.press('Control+/')
  await expect(guide(page)).toBeVisible()
  await expect(guide(page)).not.toContainText('Agent grid')
  await expect(guide(page)).not.toContainText('grid panel')
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+k')
  await palette(page).getByRole('combobox').fill('>agent grid')
  const option = palette(page).getByRole('option', { name: /^Agent grid/ })
  await expect(option).toContainText('Grid is off')
  await option.click()
  await toasts(page).filter({ hasText: 'Grid is off' }).getByRole('button', { name: 'Turn on' }).click()
  await expect(toasts(page).filter({ hasText: 'Grid is on' })).toBeVisible()
  await page.goto('/#agents')
  await expect(panelOf(page, title)).toHaveCount(1)
  const rows = await apiData<WorkspaceGrid[]>(request, '/mods/grid/layouts')
  expect(rows.find((row) => row.workspace_id === main?.id)?.layout.panels).toEqual(layout.panels)
})
