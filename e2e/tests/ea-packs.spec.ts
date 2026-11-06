import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { BUILTIN_ROLES, type AuditPage, type ContextPack, type EaHealth, type EaPackPrompt } from '@seti/shared'
import { EA_HEADERS } from './support/env.js'
import { fakeEaChat, type FakeChat } from './support/fake-ea.js'
import { apiData, expect, test, waitForToastsToClear } from './support/fixtures.js'

const READY: EaHealth = {
  ok: true,
  configured: true,
  missing: [],
  model: 'gpt-4.1-mini',
  text_model: 'gpt-4.1',
  chat_missing: [],
  turn: true,
}
const WATCHER = BUILTIN_ROLES.find((role) => role.name === 'Watcher')

const main = (page: Page) => page.getByRole('main')
const panel = (page: Page) => page.locator('dl[aria-label="EA settings"]')

async function newPack(request: APIRequestContext, name: string, body: string): Promise<ContextPack> {
  const response = await request.post('/api/context/packs', { data: { name, description: '', body } })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { data: ContextPack }).data
}

/** What the EA reads before each turn, with its own token, as the real EA does. */
async function eaPrompt(request: APIRequestContext): Promise<EaPackPrompt> {
  const response = await request.get('/api/ea/context-packs/prompt', { headers: EA_HEADERS })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { data: EaPackPrompt }).data
}

async function unlinkAll(request: APIRequestContext): Promise<void> {
  await request.put('/api/ea/context-packs', { data: { pack_ids: [] } })
}

async function openSettings(page: Page): Promise<void> {
  await main(page).getByRole('button', { name: 'EA settings' }).click()
  await expect(panel(page)).toBeVisible()
}

async function linkInDialog(page: Page, name: string): Promise<void> {
  await panel(page).getByRole('button', { name: 'Edit EA context packs' }).click()
  const dialog = page.getByRole('dialog', { name: 'Context packs of the EA' })
  await dialog.getByRole('switch', { name }).click()
  await expect(dialog.getByRole('switch', { name })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // The change's toast lands over the cog, and a pointer on it holds the toast there
  await waitForToastsToClear(page)
}

let chat: FakeChat | null = null

test.afterEach(async ({ request }) => {
  await chat?.close()
  chat = null
  await unlinkAll(request)
  await request.delete('/api/ea/history')
})

test("a role and a pack linked from the EA cog reach the EA's next typed turn", async ({ page, request }) => {
  test.setTimeout(60_000)
  const tag = randomUUID().slice(0, 8)
  const pack = await newPack(request, `E2E EA pack ${tag}`, `Release trains leave on Tuesdays (${tag}).`)
  try {
    await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
    chat = await fakeEaChat(page)
    await page.goto('/#ea')
    await openSettings(page)
    await expect(panel(page).getByRole('list', { name: 'EA context packs' })).toBeHidden()
    await expect(panel(page)).toContainText('None')
    await panel(page).getByRole('combobox', { name: 'Role' }).selectOption({ label: 'Watcher' })
    await expect(panel(page).getByTestId('task-role')).toContainText('Watcher: you monitor channels')
    await linkInDialog(page, pack.name)

    await openSettings(page)
    await expect(panel(page).getByRole('list', { name: 'EA context packs' })).toContainText(pack.name)
    await page.keyboard.press('Escape')

    const composer = main(page).getByRole('combobox', { name: 'Message the EA' })
    await composer.fill('When do release trains leave?')
    await composer.press('Enter')
    const turn = await chat.next()
    expect(turn.text).toBe('When do release trains leave?')
    const { text } = await eaPrompt(request)
    expect(text.indexOf('## Your role')).toBe(0)
    expect(text).toContain(WATCHER?.text ?? 'missing')
    expect(text.indexOf(`## Context pack: ${pack.name}`)).toBeGreaterThan(text.indexOf('## Your role'))
    expect(text).toContain(`Release trains leave on Tuesdays (${tag}).`)
    turn.send({ type: 'text', delta: 'On Tuesdays.' })
    turn.send({ type: 'done', ids: [] })
    turn.end()

    const audit = await apiData<AuditPage>(request, '/audit?kind=ea.context_packs_changed')
    expect(audit.events.map((event) => event.summary)).toEqual(
      expect.arrayContaining(['Role of the EA: Watcher', `Context packs of the EA: ${pack.name}`]),
    )

    await page.goto(`/#context/pack:${pack.id}`)
    await expect(main(page).getByLabel('Linked to')).toHaveText('Linked to EA')
  } finally {
    await request.put('/api/ea/role', { data: { pack_id: null } })
    await unlinkAll(request)
    await request.delete(`/api/context/packs/${pack.id}`)
  }
})

test('the EA cog warns when the linked packs run past what the EA reads', async ({ page, request }) => {
  const tag = randomUUID().slice(0, 8)
  const long = await newPack(request, `E2E long pack ${tag}`, 'Facts. '.repeat(1_500))
  try {
    await page.goto('/#ea')
    await openSettings(page)
    await expect(panel(page).getByRole('status')).toBeHidden()
    await linkInDialog(page, long.name)
    await openSettings(page)
    await expect(panel(page).getByRole('status')).toContainText('the EA reads the first 8,000, so the rest is cut')
    const prompt = await eaPrompt(request)
    expect(prompt.chars).toBeGreaterThan(prompt.max_chars)
    expect(prompt.text.length).toBeLessThanOrEqual(prompt.max_chars)
  } finally {
    await unlinkAll(request)
    await request.delete(`/api/context/packs/${long.id}`)
  }
})
