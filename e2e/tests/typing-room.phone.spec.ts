import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { Envelope, Task, WorkspaceEntry } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { PERMISSION_COMMAND, PERMISSION_PROMPT } from './support/fake-permission.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { mainGrid } from './support/grid.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, screenRows, shellRows, terminalIn, terminalInput } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

/** Roughly a phone keyboard; the specs shrink the viewport by this much to stand in for one. */
const KEYBOARD_PX = 300

const assistant = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    session_id: 'typing-session',
    uuid: randomUUID(),
  })

/** An idle agent with a transcript longer than the screen and one linked PR. */
async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, title, paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: `Start ${title}.` }), at)
  for (let step = 0; step < 30; step++) {
    await db.message(id, 'sdk', assistant(`Typing step ${String(step)} of ${title}.`), at)
  }
  await db.run(
    `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, 'https://github.com/e2e/docs/pull/7', ?, 'user')`,
    id,
    at,
  )
  await db.close()
  return id
}

const appHeader = (page: Page) => page.getByRole('banner')
const statusBar = (page: Page) => page.getByRole('contentinfo')
const agentHeader = (page: Page) => page.getByTestId('agent-header')
const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })
const reply = (page: Page) => page.getByLabel('Reply', { exact: true })

const height = async (locator: Locator) => (await locator.boundingBox())?.height ?? 0

async function inViewport(page: Page, locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()?.height ?? 0
  return box !== null && box.y >= 0 && box.y + box.height <= viewport + 1
}

const atLatest = async (page: Page) =>
  transcript(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 2)

async function openKeyboard(page: Page): Promise<{ width: number; height: number }> {
  const full = page.viewportSize() ?? { width: 390, height: 844 }
  await page.setViewportSize({ width: full.width, height: full.height - KEYBOARD_PX })
  return full
}

test('typing on a phone hands the transcript and reply box the room, then gives it back', async ({ page }) => {
  const title = unique('Typing room')
  const id = await seedAgent(title)
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText(`Typing step 29 of ${title}.`)).toBeVisible()
  const header = agentHeader(page)
  await expect(appHeader(page), 'the agent view keeps the app header').toBeVisible()
  await expect(statusBar(page), 'and the status bar').toBeHidden()
  await expect(header).toBeVisible()

  await reply(page).tap()
  await expect(reply(page)).toBeFocused()
  await expect(header, 'focus alone, with no keyboard, keeps the chrome').toBeVisible()
  const full = await openKeyboard(page)

  await expect(header, 'the keyboard leaves only the chat and the reply box').toBeHidden()
  await expect(appHeader(page)).toBeHidden()
  await expect(statusBar(page)).toBeHidden()
  const typingRoom = await height(transcript(page))

  await reply(page).fill('Checked from a phone')
  const send = page.getByRole('button', { name: 'Send' })
  await expect.poll(async () => inViewport(page, reply(page))).toBe(true)
  await expect.poll(async () => inViewport(page, send)).toBe(true)
  expect(await height(send)).toBeGreaterThanOrEqual(44)
  await expect.poll(async () => atLatest(page)).toBe(true)

  await reply(page).blur()
  await expect(header.getByRole('button', { name: 'More actions' })).toBeVisible()
  await expect(appHeader(page)).toBeVisible()
  expect(typingRoom, 'the same viewport gives the transcript more room while typing').toBeGreaterThan(
    (await height(transcript(page))) + 40,
  )
  await expect.poll(async () => atLatest(page)).toBe(true)

  await reply(page).tap()
  await expect(header).toBeHidden()
  await page.setViewportSize(full)
  await expect(header, 'closing the keyboard brings the chrome back').toBeVisible()
  await expect(reply(page)).toHaveValue('Checked from a phone')
  await expect.poll(async () => atLatest(page)).toBe(true)
})

test('a permission request that arrives while typing shows above the keyboard', async ({ page, request }) => {
  const response = await request.post('/api/tasks', {
    data: {
      title: unique('Typing permission'),
      prompt: `Please ${PERMISSION_PROMPT}`,
      cwd: paths.checkout,
      sandbox: false,
    },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await page.goto(`/#agents/${id}`)
  await reply(page).tap()
  await openKeyboard(page)
  await expect(appHeader(page)).toBeHidden()

  const card = page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })
  await expect(card).toContainText(PERMISSION_COMMAND)
  await expect.poll(async () => inViewport(page, card.getByRole('button', { name: 'Allow', exact: true }))).toBe(true)
  await expect(reply(page)).toBeFocused()
  await expect(statusBar(page)).toBeHidden()
})

/** Opens the terminal alone from the menu, as a phone has no sidebar or grid. */
async function openTerminal(page: Page): Promise<Locator> {
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  return terminalIn(page)
}

/** Checks a terminal hands its rows the room while the keyboard is up and gives it back after. */
async function expectTerminalRoom(page: Page, terminal: Locator): Promise<void> {
  const input = terminalInput(terminal)
  const keys = terminal.getByRole('toolbar', { name: 'Terminal keys' })
  const switcher = terminal.getByRole('button', { name: 'Switch terminal' })
  await run(terminal, 'echo before-$((2+3))')
  await expect(screenOf(terminal)).toContainText('before-5')
  const resting = (await screenRows(terminal)).drawn

  const full = await openKeyboard(page)
  await expect(appHeader(page)).toBeHidden()
  await expect(statusBar(page)).toBeHidden()
  await expect(switcher).toBeHidden()
  await expect(keys).toBeVisible()
  await expect.poll(async () => inViewport(page, keys)).toBe(true)
  await expect.poll(async () => (await screenRows(terminal)).fit).toBeGreaterThan(0)
  const typing = await screenRows(terminal)
  expect(typing.drawn, 'xterm refits to the room it is given').toBe(typing.fit)
  expect(await shellRows(terminal), 'the shell hears the new size').toBe(typing.drawn)
  await expect(screenOf(terminal)).toContainText('before-5')

  await input.blur()
  await expect(appHeader(page)).toBeVisible()
  await expect(statusBar(page)).toBeVisible()
  await expect(switcher).toBeVisible()
  await expect.poll(async () => (await screenRows(terminal)).drawn).toBeLessThan(typing.drawn - 4)

  await page.setViewportSize(full)
  await expect.poll(async () => (await screenRows(terminal)).drawn).toBe(resting)
  await expect(screenOf(terminal)).toContainText('before-5')
}

test('the terminal page gives xterm the room while the keyboard is up', async ({ page }) => {
  const terminal = await openTerminal(page)
  await expectTerminalRoom(page, terminal)
})

test('a terminal tile opened on a phone gives xterm the room while the keyboard is up', async ({ page, request }) => {
  const [main] = await apiData<WorkspaceEntry[]>(request, '/workspaces')
  const tile = { id: randomUUID(), name: 'Typing tile', task: null }
  const layout = { panels: [{ i: 'p1', agent: null, terminal: tile, x: 0, y: 0, w: 12, h: 24 }], locked: false }
  expect((await request.put(`/api/mods/grid/layouts/${main?.id ?? ''}`, { data: { layout } })).ok()).toBe(true)
  const terminal = await openTerminal(page)
  await expect(terminal.getByRole('button', { name: 'Switch terminal' })).toHaveText('Typing tile')
  await expectTerminalRoom(page, terminal)

  await terminal.getByRole('button', { name: 'Close terminal', exact: true }).tap()
  await expect.poll(async () => (await mainGrid(request))?.layout.panels).toEqual([])
})
