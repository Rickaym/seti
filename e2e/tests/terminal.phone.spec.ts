import { randomUUID } from 'node:crypto'
import type { WorkspaceEntry } from '@seti/shared'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { mainGrid } from './support/grid.js'
import { tapMoreAction } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, startIdleAgent, terminalIn, terminalInput, typedInput } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test("an agent's More sheet opens a terminal alone on the whole screen, with the keys and a switcher", async ({
  page,
  request,
}) => {
  const title = unique('Phone terminal')
  const id = await startIdleAgent(request, title)
  await page.goto(`/#agents/${id}`)
  await tapMoreAction(page, 'Terminal')
  await expect(page).toHaveURL(/#agents\/terminal\/[\w-]+$/u)
  const terminal = terminalIn(page)
  const switcher = terminal.getByRole('button', { name: 'Switch terminal' })
  await expect(switcher).toHaveText(title)
  const box = await terminal.boundingBox()
  const viewport = page.viewportSize()
  expect(box?.width).toBe(viewport?.width)
  expect(box?.height).toBeGreaterThan((viewport?.height ?? 0) * 0.8)
  const keys = terminal.getByRole('toolbar', { name: 'Terminal keys' })
  await expect(keys.getByRole('button').first()).toHaveText('Esc')

  await run(terminal, 'pwd; echo start-$((5+5)); sleep 30 && echo after-$((1+2))')
  await expect(screenOf(terminal)).toContainText(paths.checkout)
  await expect(screenOf(terminal)).toContainText('start-10')
  await keys.getByRole('button', { name: 'Control' }).tap()
  await expect(keys.getByRole('button', { name: 'Control' })).toHaveAttribute('aria-pressed', 'true')
  await terminalInput(terminal).press('c')
  await expect(keys.getByRole('button', { name: 'Control' })).toHaveAttribute('aria-pressed', 'false')
  await run(terminal, 'echo phone-$((1+1))')
  await expect(screenOf(terminal)).toContainText('phone-2')
  await expect(screenOf(terminal)).not.toContainText('after-3')
  await keys.getByRole('button', { name: 'Escape' }).tap()
  await expect(terminal).toBeVisible()
  await expectFitsPhone(page, 'terminal')

  await switcher.tap()
  await page.getByRole('menuitem', { name: 'New terminal' }).tap()
  await expect(switcher).toHaveText('Terminal')
  await run(terminal, 'echo second-$((2+2))')
  await expect(screenOf(terminal)).toContainText('second-4')
  await switcher.tap()
  await expect(page.getByRole('menuitem')).toHaveText([title, 'Terminal', 'New terminal', 'Rename'])
  await expectFitsPhone(page, 'terminal switcher')
  await page.getByRole('menuitem', { name: title }).tap()
  await expect(switcher).toHaveText(title)
  await expect(screenOf(terminal)).toContainText('phone-2')
  await expect(screenOf(terminal)).not.toContainText('second-4')
  await switcher.tap()
  await page.getByRole('menuitem', { name: 'Terminal', exact: true }).tap()
  await expect(screenOf(terminal)).toContainText('second-4')

  await terminal.getByRole('button', { name: 'Close terminal', exact: true }).tap()
  await expect(switcher).toHaveText(title)
  await page.reload()
  await expect(screenOf(terminal)).toContainText('phone-2')
  await terminal.getByRole('button', { name: 'Back to agents' }).tap()
  await expect(terminal).toHaveCount(0)
})

test('terminal tiles from the desktop grid open alone, since phones have no grid', async ({ page, request }) => {
  const [main] = await apiData<WorkspaceEntry[]>(request, '/workspaces')
  const tile = { id: randomUUID(), name: 'Grid shell', task: null }
  const layout = { panels: [{ i: 'p1', agent: null, terminal: tile, x: 0, y: 0, w: 12, h: 24 }], locked: false }
  expect((await request.put(`/api/mods/grid/layouts/${main?.id ?? ''}`, { data: { layout } })).ok()).toBe(true)
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  const terminal = terminalIn(page)
  await expect(terminal.getByRole('button', { name: 'Switch terminal' })).toHaveText('Grid shell')
  await expect(terminal.getByRole('button', { name: 'Restart', exact: true })).toHaveCount(0)
  await run(terminal, 'echo tile-$((3+4))')
  await expect(screenOf(terminal)).toContainText('tile-7')

  await terminal.getByRole('button', { name: 'Close terminal', exact: true }).tap()
  await expect(terminal).toHaveCount(0)
  await expect.poll(async () => (await mainGrid(request))?.layout.panels).toEqual([])
})

test('Shift+Enter on the input line sends a new line, and an OSC 52 copy reaches the clipboard', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const sent = typedInput(page)
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  const terminal = terminalIn(page)
  await run(terminal, 'echo ready-$((1+1))')
  await expect(screenOf(terminal)).toContainText('ready-2')
  const start = sent.length
  await terminalInput(terminal).press('Shift+Enter')
  await expect.poll(() => sent.slice(start)).toEqual(['\x1b\r'])
  await expect(terminalInput(terminal)).toHaveValue('')

  await page.evaluate(async () => navigator.clipboard.writeText('kept'))
  await run(terminal, String.raw`printf '\033]52;c;?\a'; printf '\033]52;c;%s\a' "$(printf osc-%s 52 | base64)"`)
  await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toBe('osc-52')
  expect(
    sent.filter((data) => data.includes(']52;')),
    'a read request gets no answer',
  ).toEqual([])
})
