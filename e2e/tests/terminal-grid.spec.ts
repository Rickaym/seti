import type { WorkspaceEntry } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { mainGrid, toolbar } from './support/grid.js'
import {
  run,
  screenOf,
  screenRows,
  shellPid,
  shellRows,
  terminalButton,
  terminalIn,
  tileIn,
} from './support/terminal.js'

test.beforeEach(async ({ request }) => {
  const [main] = await apiData<WorkspaceEntry[]>(request, '/workspaces')
  const empty = { layout: { panels: [], locked: false } }
  expect((await request.put(`/api/mods/grid/layouts/${main?.id ?? ''}`, { data: empty })).ok()).toBe(true)
})

async function pidIn(scope: Parameters<typeof screenOf>[0]): Promise<string> {
  await expect.poll(async () => shellPid(screenOf(scope))).not.toBe('')
  return shellPid(screenOf(scope))
}

test('in the grid the terminal button adds a tile that keeps its shell across a reload, Tidy and leaving the grid', async ({
  page,
  request,
}) => {
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  await terminalButton(page).click()
  const tile = tileIn(page)
  await expect(tile).toBeVisible()
  await expect(page.locator('[data-grid-panel][data-grid-focused="true"]')).toHaveAttribute('data-grid-terminal', '')
  await expect(toolbar(page)).toContainText('1 panel')
  await expect(terminalIn(page)).toHaveCount(0)

  await run(tile, 'echo seti-tile; echo pid-$$')
  await expect(screenOf(tile)).toContainText(/echo seti-tile.*seti-tile/u)
  const pid = await pidIn(tile)
  await expect
    .poll(async () => (await mainGrid(request))?.layout.panels)
    .toMatchObject([{ agent: null, terminal: { name: 'Terminal', task: null } }])

  await page.reload()
  await expect(screenOf(tile)).toContainText(`pid-${pid}`)
  await toolbar(page).getByRole('button', { name: 'Tidy', exact: true }).click()
  await run(tile, 'echo after-reload-$$')
  await expect(screenOf(tile)).toContainText(`after-reload-${pid}`)

  await terminalButton(page).click()
  const second = tileIn(page, 'Terminal 2')
  await expect(second).toBeVisible()
  await expect(toolbar(page)).toContainText('2 panels')
  await second.getByRole('button', { name: 'Close terminal' }).click()
  await expect(second).toHaveCount(0)

  await tile.getByRole('button', { name: 'More terminal actions' }).click()
  await page.getByRole('menuitem', { name: 'Remove from grid' }).click()
  await expect(tile).toHaveCount(0)
  await expect.poll(async () => (await mainGrid(request))?.layout.panels).toEqual([])
  await page.getByRole('option', { name: /^Terminal terminal$/u }).click()
  await run(tile, 'echo back-$$')
  await expect(screenOf(tile)).toContainText(`back-${pid}`)
  await expect(screenOf(tile)).toContainText('seti-tile')

  await tile.getByRole('button', { name: 'More terminal actions' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await tile.getByRole('textbox', { name: 'Terminal name' }).fill('build')
  await page.keyboard.press('Enter')
  const renamed = tileIn(page, 'build')
  await expect(renamed.getByRole('heading', { name: 'build' })).toBeVisible()
  await expect
    .poll(async () => (await mainGrid(request))?.layout.panels.map((panel) => panel.terminal?.name))
    .toEqual(['build'])

  const id = (await mainGrid(request))?.layout.panels[0]?.terminal?.id ?? ''
  await page.goto('about:blank')
  expect((await request.post(`/api/terminals/${id}/stop`, { data: {} })).ok(), 'stop the unseen shell').toBe(true)
  await page.goto('/#agents')
  await expect(renamed.getByRole('button', { name: 'Restart', exact: true })).toHaveCount(0)
  await run(renamed, 'echo fresh-pid-$$')
  await expect(screenOf(renamed)).toContainText(/fresh-pid-\d+/u)
  expect(await shellPid(screenOf(renamed))).not.toBe(pid)

  await renamed.getByRole('button', { name: 'Close terminal' }).click()
  await expect(renamed).toHaveCount(0)
  await expect.poll(async () => (await mainGrid(request))?.layout.panels).toEqual([])
})

test('a tile gives its shell every row it has, even when it resizes while its shell connects', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 600 })
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  await toolbar(page).getByRole('button', { name: 'Terminal', exact: true }).click()
  const first = tileIn(page)
  await run(first, 'echo ready-$((1+1))')
  await expect(screenOf(first)).toContainText('ready-2')
  const rows = await shellRows(first)
  expect(rows).toBe((await screenRows(first)).drawn)
  expect(rows).toBe((await screenRows(first)).fit)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const slow = { offline: false, latency: 400, downloadThroughput: -1, uploadThroughput: -1 }
  await cdp.send('Network.emulateNetworkConditions', slow)
  await toolbar(page).getByRole('button', { name: 'Terminal', exact: true }).click()
  const second = tileIn(page, 'Terminal 2')
  await expect(second.locator('.xterm')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const tile of [first, second]) {
    await expect.poll(async () => shellRows(tile)).toBeGreaterThan(rows)
    const { drawn, fit } = await screenRows(tile)
    expect(await shellRows(tile)).toBe(drawn)
    expect(drawn).toBe(fit)
  }
})

test('the empty grid picks a terminal, and several tiles each keep their own shell', async ({ page }) => {
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  await page.getByRole('option', { name: 'New terminal' }).click()
  await expect(tileIn(page)).toBeVisible()
  await toolbar(page).getByRole('button', { name: 'Terminal', exact: true }).click()
  const second = tileIn(page, 'Terminal 2')
  await expect(second).toBeVisible()
  await run(second, 'echo two-$((1+1))')
  await expect(screenOf(second)).toContainText('two-2')
  await expect(screenOf(tileIn(page))).not.toContainText('two-2')
  await expect(page.getByRole('region', { name: /^Terminal tile: / })).toHaveCount(2)
})
