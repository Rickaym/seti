import type { Page } from '@playwright/test'
import type { AuditPage, EaHealth } from '@seti/shared'
import { EA_HEADERS } from './support/env.js'
import { botSays, fakeEa, fakeEaChat, type FakeChat } from './support/fake-ea.js'
import { apiData, expect, test } from './support/fixtures.js'
import { askToThink, thinkingLine } from './support/think.js'

test.use({ permissions: ['microphone'] })

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }

let chat: FakeChat | null = null

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/ea/history')).ok()).toBe(true)
})

test.afterEach(async ({ request }) => {
  await chat?.close()
  chat = null
  await request.delete('/api/ea/history')
})

async function openEa(page: Page) {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  await page.goto('/#ea')
  await expect(page.getByRole('main').getByRole('heading', { name: 'EA', level: 1 })).toBeVisible()
}

test('a typed think shows a Thinking line with its progress, then the answer', async ({ page, request }) => {
  await openEa(page)
  chat = await fakeEaChat(page)
  await askToThink(page, chat, request, async (text) => {
    const composer = page.getByRole('combobox', { name: 'Message the EA' })
    await composer.fill(text)
    await composer.press('Enter')
  })
  await expect(thinkingLine(page)).toHaveCount(0)
})

test('on a call the running think shows what it reads on the call card', async ({ page }) => {
  await fakeEa(page)
  await openEa(page)
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Call', exact: true }).click()
  const card = main.getByRole('region', { name: 'Live call' })
  await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')
  const live = card.getByRole('list', { name: 'Live' })

  await botSays(page, 'llm-function-call-in-progress', { function_name: 'think', tool_call_id: 't1' })
  const think = live.locator('[data-kind="action"]').filter({ hasText: 'think' })
  await expect(think).toContainText('Working...')
  await botSays(page, 'server-message', { type: 'ea-progress', tool: 'think', text: 'Weighing it up.' })
  await expect(think).toContainText('Weighing it up.')
  await botSays(page, 'server-message', { type: 'ea-progress', tool: 'think', text: "I'm going through the open PRs." })
  await expect(think).toContainText("I'm going through the open PRs.")
  await expect(think.getByLabel('Running')).toBeVisible()

  await botSays(page, 'server-message', { type: 'ea-action', tool: 'think', summary: 'Merge PR 12 first.', ok: true })
  await botSays(page, 'llm-function-call-stopped', { function_name: 'think', tool_call_id: 't1', cancelled: false })
  await expect(think).toContainText('Merge PR 12 first.')
  await expect(think.getByLabel('Done')).toBeVisible()
})

test('the bot audits a think in numbers only', async ({ request }) => {
  const thought = { channel: 'voice', outcome: 'answered', question_chars: 31, duration_ms: 21_000, tool_rounds: 2 }
  expect((await request.post('/api/ea/thoughts', { headers: EA_HEADERS, data: thought })).ok()).toBe(true)
  const audit = await apiData<AuditPage>(request, '/audit?kind=ea.thought&limit=1')
  expect(audit.events[0]).toMatchObject({
    actor: 'user',
    summary: 'EA thought a question through in 21 s with 2 rounds of reading: answered',
  })
  const withText = { ...thought, question: 'Which PR should I merge first?' }
  expect((await request.post('/api/ea/thoughts', { headers: EA_HEADERS, data: withText })).status()).toBe(400)
})
