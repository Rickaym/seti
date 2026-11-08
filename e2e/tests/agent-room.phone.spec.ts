import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectClear, PORTRAIT, safeAreas } from './support/ios.js'
import { moreRow, tapMoreAction } from './support/phone-agent.js'
import { edgesAtRest, expectFitsPhone, settled } from './support/phone-layout.js'

const TARGET_PX = 44
/** The terminal bar's 44px row and its rule, which the agent header shares. */
const HEADER_MAX_PX = 45
/** One line of reply box plus its padding and rule. */
const COMPOSER_MAX_PX = 56
/** Share of the viewport the transcript gets with the keyboard closed. */
const TRANSCRIPT_SHARE = 0.75
const NARROWEST = { width: 320, height: 568 }

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
    session_id: 'room-session',
    uuid: randomUUID(),
  })

/** An agent with a transcript longer than the screen, a status line and a linked PR. */
async function seedAgent(title: string, status = 'idle'): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, title, paths.checkout, at)
  for (let step = 0; step < 30; step++) {
    await db.message(id, 'sdk', assistant(`Room step ${String(step)} of ${title}.`), at)
  }
  await db.run('UPDATE task SET status = ?, status_line = ? WHERE id = ?', status, 'Waiting on CI', id)
  await db.run(
    `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, 'https://github.com/e2e/docs/pull/9', ?, 'user')`,
    id,
    at,
  )
  await db.close()
  return id
}

async function seedNeedsYou(): Promise<void> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, unique('Needs you elsewhere'), paths.checkout, new Date().toISOString())
  await db.run(`UPDATE task SET status = 'error', last_error = 'exit 1', unseen = true WHERE id = ?`, id)
  await db.close()
}

const header = (page: Page) => page.getByTestId('agent-header')
const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })
const reply = (page: Page) => page.getByLabel('Reply', { exact: true })
const composer = (page: Page) => page.locator('[class*="@container/composer"]')

async function openAgent(page: Page, title: string, status?: string): Promise<void> {
  const id = await seedAgent(title, status)
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText(`Room step 29 of ${title}.`)).toBeVisible()
}

async function heightOf(page: Page, locator: Locator): Promise<number> {
  return (await edgesAtRest(page, locator)).height
}

async function expectTouchSized(locator: Locator, name: string): Promise<void> {
  const box = await locator.boundingBox()
  expect(Math.min(box?.width ?? 0, box?.height ?? 0), name).toBeGreaterThanOrEqual(TARGET_PX)
}

test('the agent view gives the chat the screen: the app header, one agent row, a slim reply box', async ({ page }) => {
  await openAgent(page, unique('Room budget'))
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('contentinfo')).toBeHidden()
  expect(await heightOf(page, header(page))).toBeLessThanOrEqual(HEADER_MAX_PX)
  expect(await heightOf(page, composer(page))).toBeLessThanOrEqual(COMPOSER_MAX_PX)
  const viewport = page.viewportSize()?.height ?? 0
  expect(await heightOf(page, transcript(page))).toBeGreaterThanOrEqual(viewport * TRANSCRIPT_SHARE)
  await expectFitsPhone(page, 'agent view')

  await reply(page).fill('One line, then a second line\nand a third line\nthat the box grows to show')
  expect(await heightOf(page, composer(page))).toBeGreaterThan(COMPOSER_MAX_PX + 40)
  await reply(page).fill('')

  await header(page).getByRole('button', { name: 'Back to agents' }).tap()
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('contentinfo')).toBeVisible()
})

test('the agent header matches the terminal bar, and the terminal opens from More', async ({ page }) => {
  await openAgent(page, unique('Room terminal'))
  const agentBar = await edgesAtRest(page, header(page))
  await tapMoreAction(page, 'Terminal')
  await expect(page).toHaveURL(/#agents\/terminal\/[\w-]+$/u)
  const bar = page
    .getByRole('region', { name: 'Terminal' })
    .getByRole('button', { name: 'Switch terminal' })
    .locator('..')
  expect((await edgesAtRest(page, bar)).height).toBe(agentBar.height)
})

test('the More sheet keeps search, the group chat and the agent tools in reach', async ({ page }) => {
  await openAgent(page, unique('Room actions'))
  const actions = page.getByRole('dialog', { name: 'Agent actions' })
  await header(page).getByRole('button', { name: 'More actions' }).tap()
  await expect(actions).toBeVisible()
  await settled(page)
  for (const name of [
    'Find in this chat',
    'Files',
    'Processes',
    'Pin',
    'Rename',
    'Terminal',
    'Search Seti',
    'Group chat',
  ]) {
    await expectTouchSized(moreRow(page, name), name)
  }
  await actions.getByRole('button', { name: 'Search Seti' }).tap()
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()

  await header(page).getByRole('button', { name: 'More actions' }).tap()
  await actions.getByRole('button', { name: 'Group chat' }).tap()
  await expect(page.getByTestId('team-chat-panel')).toBeVisible()
})

test('a busy agent on a 320px phone keeps its title, Stop and every control at 44px', async ({ page }) => {
  await seedNeedsYou()
  await page.setViewportSize(NARROWEST)
  await openAgent(page, unique('Room narrow'), 'running')
  const row = header(page)
  const back = row.getByRole('button', { name: 'Back to agents' })
  await expect(back).toHaveAccessibleDescription(/need(s)? you$/)
  await expect(row.getByTestId('needs-you-badge')).toBeVisible()
  for (const name of ['Back to agents', 'Stop', 'Agent settings', 'More actions']) {
    const button = row.getByRole('button', { name, exact: true })
    await expect(button).toBeInViewport({ ratio: 1 })
    await expectTouchSized(button, name)
  }
  await expect(row.getByRole('img', { name: 'running' })).toBeVisible()
  expect(await heightOf(page, row)).toBeLessThanOrEqual(HEADER_MAX_PX)
  await expectFitsPhone(page, 'busy agent at 320px')
})

test('with the notch and home indicator the header and reply box stay clear of both', async ({ page }) => {
  await safeAreas(page, PORTRAIT)
  await openAgent(page, unique('Room insets'))
  await expectClear(page, header(page).getByRole('button', { name: 'Back to agents' }), PORTRAIT, 'back button')
  await expectClear(page, header(page).getByRole('button', { name: 'More actions' }), PORTRAIT, 'more button')
  await expectClear(page, reply(page), PORTRAIT, 'reply box')
  await expectClear(page, page.getByRole('button', { name: 'Send' }), PORTRAIT, 'send button')
})
