import { randomUUID } from 'node:crypto'
import type { AgentProcesses, TerminalStatus, WorkspaceEntry } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import {
  run,
  screenOf,
  screenRows,
  shellPid,
  shellRows,
  startIdleAgent,
  switchTo,
  terminalButton,
  terminalIn,
  tileIn,
  typedInput,
} from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('with an agent open alone, the button opens a terminal alone in its folder that a reload reattaches', async ({
  page,
  request,
}) => {
  const title = unique('Terminal')
  const id = await startIdleAgent(request, title)
  await page.goto(`/#agents/${id}`)
  await terminalButton(page).click()
  await expect(page).toHaveURL(/#agents\/terminal\/[\w-]+$/u)
  const terminal = terminalIn(page)
  await expect(terminal.getByRole('button', { name: 'Switch terminal' })).toHaveText(title)
  await expect(terminal.getByText('on this machine')).toBeVisible()
  await run(terminal, 'echo seti-alone && pwd')
  await expect(screenOf(terminal)).toContainText(/echo seti-alone.*seti-alone/u)
  await expect(screenOf(terminal)).toContainText(paths.checkout)
  const shells = async () => (await apiData<AgentProcesses>(request, `/tasks/${id}/processes`)).terminals
  await expect.poll(shells).toMatchObject([{ attached: true, sandboxed: false, shell: '/bin/bash' }])
  const [{ pid }] = (await shells()) as [TerminalStatus]

  await page.reload()
  await expect(screenOf(terminal)).toContainText(/echo seti-alone.*seti-alone/u)
  await expect.poll(async () => (await shells())[0]).toMatchObject({ pid, attached: true })

  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Settings' }).click()
  await expect(terminal).toHaveCount(0)
  await expect.poll(async () => (await shells())[0]).toMatchObject({ pid, attached: false })
  await page.keyboard.press('Control+Backquote')
  await expect(screenOf(terminal)).toContainText('seti-alone')
  await expect.poll(async () => (await shells())[0]).toMatchObject({ pid, attached: true })

  await terminal.getByRole('button', { name: 'Close terminal', exact: true }).click()
  await expect(terminal).toHaveCount(0)
  await expect(page).toHaveURL(/#agents$/u)
  await expect.poll(shells).toEqual([])
})

test('the switcher opens, names and switches terminals, and a stopped shell restarts', async ({ page }) => {
  await page.goto('/#settings')
  await terminalButton(page).click()
  const terminal = terminalIn(page)
  const switcher = terminal.getByRole('button', { name: 'Switch terminal' })
  await expect(switcher).toHaveText('Terminal')
  await run(terminal, 'pwd; echo one-$((0+1))')
  await expect(screenOf(terminal)).toContainText(paths.home)
  await expect(screenOf(terminal)).toContainText('one-1')

  await switchTo(page, terminal, 'New terminal')
  await expect(switcher).toHaveText('Terminal 2')
  await run(terminal, 'echo two-$((1+1)); echo pid-$$')
  await expect(screenOf(terminal)).toContainText('two-2')
  await expect(screenOf(terminal)).not.toContainText('one-1')
  await switcher.click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const name = terminal.getByRole('textbox', { name: 'Terminal name' })
  await name.fill('build')
  await name.press('Enter')
  await expect(switcher).toHaveText('build')

  await switchTo(page, terminal, 'Terminal')
  await expect(screenOf(terminal)).toContainText('one-1')
  await switchTo(page, terminal, 'build')
  await expect(screenOf(terminal)).toContainText('two-2')
  const pid = await shellPid(screenOf(terminal))

  const id = /#agents\/terminal\/([\w-]+)$/u.exec(page.url())?.[1] ?? ''
  expect((await page.request.post(`/api/terminals/${id}/stop`, { data: {} })).ok(), 'stop the shell').toBe(true)
  await expect(terminal.getByRole('status')).toHaveText('Stopped from Seti')
  await terminal.getByRole('button', { name: 'Restart', exact: true }).click()
  await run(terminal, 'echo after-$((2+2)); echo pid-$$')
  await expect(screenOf(terminal)).toContainText('after-4')
  expect(await shellPid(screenOf(terminal))).not.toBe(pid)

  await page.goto('about:blank')
  expect((await page.request.post(`/api/terminals/${id}/stop`, { data: {} })).ok(), 'stop it unseen').toBe(true)
  await page.goto('/#settings')
  await terminalButton(page).click()
  await expect(switcher).toHaveText('build')
  await expect(terminal.getByRole('button', { name: 'Restart', exact: true })).toHaveCount(0)
  await run(terminal, 'echo again-$((3+3))')
  await expect(screenOf(terminal)).toContainText('again-6')
})

test('a terminal moves into the grid and opens alone again, keeping its shell', async ({ page, request }) => {
  const [main] = await apiData<WorkspaceEntry[]>(request, '/workspaces')
  const empty = { layout: { panels: [], locked: false } }
  expect((await request.put(`/api/mods/grid/layouts/${main?.id ?? ''}`, { data: empty })).ok()).toBe(true)
  await page.goto('/#settings')
  await terminalButton(page).click()
  const terminal = terminalIn(page)
  await run(terminal, 'echo moving-$((6*7)); echo pid-$$')
  await expect(screenOf(terminal)).toContainText('moving-42')
  const pid = await shellPid(screenOf(terminal))

  await terminal.getByRole('button', { name: 'Open in grid' }).click()
  const tile = tileIn(page)
  await expect(page.getByRole('button', { name: 'Grid', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await run(tile, 'echo tile-pid-$$')
  await expect(screenOf(tile)).toContainText(`tile-pid-${pid}`)

  await tile.getByRole('button', { name: 'More terminal actions' }).click()
  await page.getByRole('menuitem', { name: 'Open alone' }).click()
  await expect(page).toHaveURL(/#agents\/terminal\//u)
  await expect(page.getByRole('button', { name: 'Grid', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(screenOf(terminal)).toContainText(`tile-pid-${pid}`)

  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  await expect(tile).toBeVisible()
  await tile.getByRole('button', { name: 'More terminal actions' }).click()
  await page.getByRole('menuitem', { name: 'Remove from grid' }).click()
  await expect(tile).toHaveCount(0)
  await page.getByRole('option', { name: /^Terminal terminal$/u }).click()
  await run(tile, 'echo back-pid-$$')
  await expect(screenOf(tile)).toContainText(`back-pid-${pid}`)
  await tile.getByRole('button', { name: 'Close terminal' }).click()
  await expect(tile).toHaveCount(0)
})

test('the dock a viewer left becomes terminals the button opens', async ({ page }) => {
  await page.goto('/#settings')
  const id = randomUUID()
  const dock = {
    open: true,
    size: 'normal',
    height: 320,
    tabs: [
      { id: randomUUID(), name: 'Home', taskId: null, cwd: null, sandboxed: false },
      { id, name: 'Old shell', taskId: null, cwd: null, sandboxed: false },
    ],
    active: id,
  }
  await page.evaluate((stored) => {
    localStorage.setItem('seti.terminal.dock', stored)
  }, JSON.stringify(dock))
  await page.reload()
  await terminalButton(page).click()
  await expect(page).toHaveURL(new RegExp(`#agents/terminal/${id}$`, 'u'))
  const terminal = terminalIn(page)
  await expect(terminal.getByRole('button', { name: 'Switch terminal' })).toHaveText('Old shell')
  await run(terminal, 'echo kept-$((1+1))')
  await expect(screenOf(terminal)).toContainText('kept-2')
  await terminal.getByRole('button', { name: 'Switch terminal' }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Home', 'Old shell', 'New terminal', 'Rename'])
  await page.keyboard.press('Escape')
  const stored = await page.evaluate(() => [
    localStorage.getItem('seti.terminal.dock'),
    localStorage.getItem('seti.terminals'),
  ])
  expect(stored[0]).toBeNull()
  expect(JSON.parse(stored[1] ?? '{}')).toMatchObject({ recent: id })
})

test('the shell gets every row the view has, and Ctrl+C, Ctrl+V and copy work as in a desktop terminal', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/#settings')
  await terminalButton(page).click()
  const terminal = terminalIn(page)
  await run(terminal, 'echo ready-$((1+1))')
  await expect(screenOf(terminal)).toContainText('ready-2')
  const rows = await shellRows(terminal)
  const { drawn, fit } = await screenRows(terminal)
  expect(rows).toBe(drawn)
  expect(drawn).toBe(fit)
  await page.setViewportSize({ width: 1200, height: 600 })
  await expect.poll(async () => shellRows(terminal)).toBeLessThan(rows)
  expect(await shellRows(terminal)).toBe((await screenRows(terminal)).drawn)

  await run(terminal, 'echo copy-$((6*7))-done')
  const line = screenOf(terminal)
    .locator('> div')
    .filter({ hasText: /^copy-42-done/u })
  const word = await line.locator('span').first().boundingBox()
  await page.mouse.dblclick((word?.x ?? 0) + 5, (word?.y ?? 0) + 5)
  await page.keyboard.press('Control+C')
  await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toBe('copy-42-done')

  await page.evaluate(async () => navigator.clipboard.writeText('echo pasted-$((5*5))'))
  await terminal.locator('.xterm-helper-textarea').focus()
  await page.keyboard.press('Control+V')
  await page.keyboard.press('Enter')
  await expect(screenOf(terminal)).toContainText('pasted-25')
  await expect(screenOf(terminal)).not.toContainText('^V')
  await terminal.locator('.xterm-helper-textarea').evaluate((textarea) => {
    const data = new DataTransfer()
    data.setData('text/plain', 'echo menu-$((4*4))')
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page.keyboard.press('Enter')
  await expect(screenOf(terminal)).toContainText('menu-16')

  await run(terminal, 'sleep 100')
  await page.keyboard.press('Control+C')
  await run(terminal, 'echo woke-$((2+5))')
  await expect(screenOf(terminal)).toContainText('woke-7', { timeout: 5000 })
})

test('Shift+Enter sends a new line, and a program copies to the clipboard through OSC 52 but never reads it', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const sent = typedInput(page)
  await page.goto('/#settings')
  await terminalButton(page).click()
  const terminal = terminalIn(page)
  await run(terminal, 'echo ready-$((1+1))')
  await expect(screenOf(terminal)).toContainText('ready-2')
  const start = sent.length
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => sent.slice(start)).toEqual(['\x1b\r', '\r'])

  await page.evaluate(async () => navigator.clipboard.writeText('kept'))
  await run(terminal, String.raw`printf '\033]52;c;?\a'; echo asked-$((2+3))`)
  await expect(screenOf(terminal)).toContainText('asked-5')
  await run(terminal, String.raw`printf '\033]52;c;%s\a' "$(printf osc-%s 52 | base64)"; echo wrote-$((3+4))`)
  await expect(screenOf(terminal)).toContainText('wrote-7')
  await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toBe('osc-52')
  expect(
    sent.filter((data) => data.includes(']52;')),
    'a read request gets no answer',
  ).toEqual([])
})

test("agents' own menus and header no longer carry a terminal", async ({ page }) => {
  const db = openSeedDb()
  const id = randomUUID()
  const title = unique('No terminal')
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('button', { name: 'Agent settings' })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Terminal', exact: true })).toHaveCount(0)
  await main.getByRole('button', { name: 'Open in grid' }).click()
  const cell = page.locator('[data-grid-panel]').filter({ has: page.getByRole('heading', { name: title }) })
  await cell.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Processes' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Terminal/ })).toHaveCount(0)
})
