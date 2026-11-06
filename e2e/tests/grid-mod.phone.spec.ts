import { randomUUID } from 'node:crypto'
import type { WorkspaceEntry } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { modToggle, setModEnabled } from './support/mods.js'

test.afterEach(async ({ request }) => {
  await setModEnabled(request, 'grid', true)
})

test('with the grid mod off a phone lists only its own terminals, and Settings, Mods turns it back on', async ({
  page,
  request,
}) => {
  const [main] = await apiData<WorkspaceEntry[]>(request, '/workspaces')
  const tile = { id: randomUUID(), name: 'Desk tile', task: null }
  const layout = { panels: [{ i: 'p1', agent: null, terminal: tile, x: 0, y: 0, w: 12, h: 24 }], locked: false }
  expect((await request.put(`/api/mods/grid/layouts/${main?.id ?? ''}`, { data: { layout } })).ok()).toBe(true)
  await setModEnabled(request, 'grid', false)

  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  const switcher = page.getByRole('button', { name: 'Switch terminal' })
  await expect(switcher).not.toHaveText('Desk tile')
  await switcher.tap()
  await expect(page.getByRole('menuitem', { name: /Desk tile/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.goto('/#settings/mods')
  const toggle = modToggle(page, 'Grid')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
})
