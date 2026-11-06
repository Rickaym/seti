import type { Locator, Page } from '@playwright/test'
import type { ModList, WorkspaceEntry } from '@seti/shared'
import { seedLongTranscript } from './support/chat-search.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { focusedPanel, panelOf, rectOf, startAgent } from './support/grid.js'
import { modToggle, setModEnabled } from './support/mods.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, terminalButton, tileIn } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test.beforeEach(async ({ request }) => {
  const [main] = await apiData<WorkspaceEntry[]>(request, '/workspaces')
  const empty = { layout: { panels: [], locked: false } }
  expect((await request.put(`/api/mods/grid/layouts/${main?.id ?? ''}`, { data: empty })).ok()).toBe(true)
})

test.afterEach(async ({ request }) => {
  await setModEnabled(request, 'vim', false)
})

const transcript = (scope: Page | Locator) => scope.getByRole('region', { name: 'Transcript' })
const mode = (page: Page) => page.getByTestId('vim-mode')
const findBar = (page: Page) => page.getByTestId('chat-find')
const cheatSheet = (page: Page) => page.getByRole('dialog', { name: 'Vim mode keys' })

/** How far the transcript sits above its newest row, in pixels. */
const fromBottom = async (scope: Page | Locator) =>
  transcript(scope).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

const scrollTop = async (scope: Page | Locator) => transcript(scope).evaluate((el) => el.scrollTop)

/** Turns the Vim mode mod on or off from Settings, Mods, as the user does. */
async function switchVim(page: Page, on: boolean): Promise<void> {
  await page.goto('/#settings/mods')
  const toggle = modToggle(page, 'Vim mode')
  await expect(toggle).toHaveAttribute('aria-pressed', String(!on))
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', String(on))
  await (on ? expect(mode(page)).toHaveText(/NORMAL|INSERT/) : expect(mode(page)).toHaveCount(0))
}

async function openLongChat(page: Page, needle: string): Promise<void> {
  const id = await seedLongTranscript(unique('Vim chat'), needle)
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText('Reply 3000 done')).toBeVisible()
}

test('with Vim mode off, single keys type or do nothing', async ({ page }) => {
  await openLongChat(page, unique('quokka'))
  await transcript(page).getByText('Reply 2999 done').click()
  const before = await scrollTop(page)
  for (const key of ['k', 'k', 'g', 'g', 'G', 'h', 'l', '/', '?', 'i', ':']) {
    await page.keyboard.press(key)
  }
  await expect(findBar(page)).toBeHidden()
  await expect(cheatSheet(page)).toBeHidden()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(mode(page)).toHaveCount(0)
  expect(await scrollTop(page)).toBe(before)

  const reply = page.getByRole('combobox', { name: 'Reply' })
  await expect(reply).not.toBeFocused()
  await reply.click()
  await page.keyboard.type('jk')
  await page.keyboard.press('Escape')
  await expect(reply).toBeFocused()
  await expect(reply).toHaveValue('jk')
  await reply.fill('')
})

test('Vim mode: Esc leaves the reply box, j k gg G scroll, / n N find and ? lists the keys', async ({ page }) => {
  test.setTimeout(60_000)
  const needle = unique('zephyrine')
  await switchVim(page, true)
  await openLongChat(page, needle)

  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.click()
  await expect(mode(page)).toHaveText('INSERT')
  await page.keyboard.type('draft')
  await page.keyboard.press('Escape')
  await expect(reply).not.toBeFocused()
  await expect(reply).toHaveValue('draft')
  await expect(mode(page)).toHaveText('NORMAL')

  expect(await fromBottom(page)).toBeLessThan(10)
  await page.keyboard.press('k')
  await page.keyboard.press('k')
  await expect.poll(async () => fromBottom(page)).toBeGreaterThan(80)
  const raised = await fromBottom(page)
  await page.keyboard.press('j')
  await expect.poll(async () => fromBottom(page)).toBeLessThan(raised)
  await page.keyboard.press('Control+u')
  await expect.poll(async () => fromBottom(page)).toBeGreaterThan(raised)
  await page.keyboard.press('g')
  await page.keyboard.press('g')
  await expect(transcript(page).getByText('Reply 3000 done')).not.toBeInViewport()
  await page.keyboard.press('Shift+G')
  await expect.poll(async () => fromBottom(page)).toBeLessThan(10)
  await expect(transcript(page).getByText('Reply 3000 done')).toBeInViewport()

  await page.keyboard.press('/')
  await expect(findBar(page)).toBeVisible()
  await expect(page.getByTestId('chat-find-input')).toBeFocused()
  await expect(mode(page)).toHaveText('INSERT')
  await page.keyboard.type(needle)
  await expect(page.getByTestId('chat-find-count')).toHaveText('1 of 3')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('chat-find-input')).not.toBeFocused()
  await expect(mode(page)).toHaveText('NORMAL')
  await expect(page.getByTestId('chat-find-count')).toHaveText('1 of 3')
  await page.keyboard.press('n')
  await expect(page.getByTestId('chat-find-count')).toHaveText('2 of 3')
  await expect(page.locator('[data-find-current]')).toContainText(`Reply 2500 found the ${needle} here`)
  await page.keyboard.press('Shift+N')
  await expect(page.getByTestId('chat-find-count')).toHaveText('1 of 3')
  await page.keyboard.press('Escape')
  await expect(findBar(page)).toBeHidden()

  await page.keyboard.press('Shift+?')
  await expect(cheatSheet(page)).toBeVisible()
  await expect(cheatSheet(page).getByText('Previous / next panel')).toBeVisible()
  await page.keyboard.press('j')
  await expect(cheatSheet(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(cheatSheet(page)).toBeHidden()

  await page.keyboard.press('a')
  await expect(reply).toBeFocused()
  await expect(mode(page)).toHaveText('INSERT')
  await page.keyboard.type(' more')
  await expect(reply).toHaveValue('draft more')
  await reply.fill('')
})

test('Vim mode moves the active grid panel with h and l and leaves terminals every key', async ({ page, request }) => {
  test.setTimeout(60_000)
  const left = unique('Vim left')
  const right = unique('Vim right')
  const leftId = await startAgent(request, left)
  const rightId = await startAgent(request, right)
  await setModEnabled(request, 'vim', true)
  await page.goto(`/#agents/${leftId}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  await expect.poll(async () => rectOf(panelOf(page, left))).toEqual([0, 0, 12, 24])
  await page.goto(`/#agents/${rightId}`)
  await expect.poll(async () => rectOf(panelOf(page, right))).toEqual([6, 0, 6, 24])

  await panelOf(page, right).getByRole('combobox', { name: 'Reply' }).click()
  await page.keyboard.press('Escape')
  await expect(mode(page)).toHaveText('NORMAL')
  await expect(focusedPanel(page)).toContainText(right)

  await page.keyboard.press('h')
  await expect(focusedPanel(page)).toContainText(left)
  await expect(page.locator('[data-panel-active]')).toContainText(left)
  await page.keyboard.press('l')
  await expect(focusedPanel(page)).toContainText(right)
  await page.keyboard.press('1')
  await expect(page.locator('[data-panel-active]').getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()

  await terminalButton(page).click()
  const tile = tileIn(page)
  await expect(tile).toBeVisible()
  await run(tile, 'echo vim-tile-ready')
  await expect(screenOf(tile)).toContainText('vim-tile-ready')
  await expect(mode(page)).toHaveText('INSERT')
  const typed = tile.locator('.xterm-helper-textarea')
  await expect(typed).toBeFocused()
  await page.keyboard.type('echo hjkl?')
  await page.keyboard.press('Enter')
  await expect(screenOf(tile)).toContainText(/echo hjkl\?.*hjkl\?/u)
  await page.keyboard.press('Escape')
  await expect(typed).toBeFocused()
  await expect(mode(page)).toHaveText('INSERT')
  await expect(cheatSheet(page)).toBeHidden()
})

test('turning the Vim mode mod off leaves no single key, and on again brings them back', async ({ page }) => {
  await switchVim(page, true)
  await openLongChat(page, unique('wombat'))
  await expect(mode(page)).toHaveText('NORMAL')
  await page.keyboard.press('Shift+?')
  await expect(cheatSheet(page)).toBeVisible()
  await page.keyboard.press('Escape')

  await switchVim(page, false)
  await page.goBack()
  await expect(transcript(page).getByText('Reply 3000 done')).toBeVisible()
  await transcript(page).getByText('Reply 2999 done').click()
  const before = await scrollTop(page)
  for (const key of ['k', 'k', 'g', 'g', '/', '?']) {
    await page.keyboard.press(key)
  }
  await expect(findBar(page)).toBeHidden()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('[data-panel-active]')).toHaveCount(0)
  expect(await scrollTop(page)).toBe(before)

  await switchVim(page, true)
  await page.goBack()
  await expect(transcript(page).getByText('Reply 3000 done')).toBeVisible()
  await transcript(page).getByText('Reply 2999 done').click()
  const again = await scrollTop(page)
  await page.keyboard.press('k')
  await page.keyboard.press('k')
  await expect.poll(async () => scrollTop(page)).toBeLessThan(again)
})

test('a browser that had Vim mode on moves that choice to the server once', async ({ page, request }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded') === null) {
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('seti-ui-vim', 'on')
    }
  })
  await page.goto('/')
  await expect(mode(page)).toHaveText(/NORMAL|INSERT/)
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('seti-ui-vim'))).toBeNull()
  const list = await apiData<ModList>(request, '/mods')
  expect(list.mods.find((mod) => mod.id === 'vim')?.enabled).toBe(true)
})
