import type { APIRequestContext, Page } from '@playwright/test'
import type { EaHealth, EaLlmMessage } from '@seti/shared'
import { EA_HEADERS } from './support/env.js'
import { botClosed, botSays, fakeEa } from './support/fake-ea.js'
import { expect, test } from './support/fixtures.js'

test.use({ permissions: ['microphone'] })

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }
const BOT = EA_HEADERS

interface Entry {
  kind: 'message' | 'call'
  message: EaLlmMessage
}

async function mockHealth(page: Page, health: EaHealth) {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: health }))
}

async function mockIce(page: Page) {
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
}

async function storeTurns(request: APIRequestContext, entries: Entry[]) {
  const response = await request.post('/api/ea/history/messages', { headers: BOT, data: { entries } })
  expect(response.ok(), 'POST /api/ea/history/messages').toBe(true)
}

async function saysBot(page: Page, segment: number, text: string) {
  await botSays(page, 'bot-output', {
    text,
    segment_id: segment,
    will_be_spoken: true,
    spoken_progress: { accumulated_text: text, remaining_text: '' },
  })
}

const eaItem = (page: Page) => page.getByRole('contentinfo').getByRole('group', { name: 'EA', exact: true })
const said = (content: string): Entry => ({ kind: 'message', message: { role: 'user', content } })
const answered = (content: string): Entry => ({ kind: 'message', message: { role: 'assistant', content } })
const callStarted: Entry = { kind: 'call', message: { role: 'developer', content: 'A new call started.' } }

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/ea/history')).ok()).toBe(true)
})

test.afterEach(async ({ request }) => {
  await request.delete('/api/ea/history')
})

test('a call from the EA page shows lines and tool calls live, then lands them in the transcript', async ({
  page,
  request,
}) => {
  await storeTurns(request, [callStarted, said('Earlier question?'), answered('Earlier answer.')])
  await mockHealth(page, READY)
  await mockIce(page)
  const { offers } = await fakeEa(page)
  await page.goto('/#ea')
  const main = page.getByRole('main')
  const transcript = main.getByRole('region', { name: 'Transcript' })
  await expect(transcript).toContainText('Earlier answer.')
  await expect(main).not.toContainText('Plan and steer your agents')

  const call = main.getByRole('button', { name: 'Call', exact: true })
  await call.hover()
  await expect(page.getByRole('tooltip')).toContainText('Talk to the EA (Ctrl+Shift+E)')
  await call.click()
  const card = main.getByRole('region', { name: 'Live call' })
  await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')
  await expect(eaItem(page).getByTestId('ea-bar-status')).toHaveText('Listening')
  await expect(call).toHaveCount(0)
  expect(offers).toHaveLength(1)

  const live = card.getByRole('list', { name: 'Live' })
  await botSays(page, 'user-input', { text: 'Which PRs', input_type: 'transcription', final: false, timestamp: '' })
  await expect(live.locator('[data-kind="user"]')).toHaveText(/Which PRs/)
  await botSays(page, 'user-input', {
    text: 'Which PRs need me?',
    input_type: 'transcription',
    final: true,
    timestamp: '',
  })
  await botSays(page, 'llm-function-call-in-progress', { function_name: 'list_prs', tool_call_id: 'x1' })
  const tool = live.locator('[data-kind="action"]')
  await expect(tool).toContainText('list_prs')
  await expect(tool.getByLabel('Running')).toBeVisible()
  await botSays(page, 'server-message', { type: 'ea-action', tool: 'list_prs', summary: 'Listed 3 PRs', ok: true })
  await botSays(page, 'llm-function-call-stopped', {
    function_name: 'list_prs',
    tool_call_id: 'x1',
    cancelled: false,
  })
  await expect(tool).toContainText('Listed 3 PRs')
  await expect(tool.getByLabel('Done')).toBeVisible()
  await botSays(page, 'bot-started-speaking')
  await saysBot(page, 1, 'Three PRs are open.')
  await expect(card.getByTestId('ea-call-status')).toHaveText('EA speaking')
  await expect(live.locator('[data-kind="bot"]')).toHaveText(/Three PRs are open\./)
  await expect(transcript).not.toContainText('Which PRs need me?')

  await storeTurns(request, [
    callStarted,
    said('Which PRs need me?'),
    {
      kind: 'message',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'x1', type: 'function', function: { name: 'list_prs', arguments: '{}' } }],
      },
    },
    { kind: 'message', message: { role: 'tool', tool_call_id: 'x1', content: '"3 PRs"' } },
    answered('Three PRs are open.'),
  ])
  await botSays(page, 'bot-stopped-speaking')
  await expect(transcript).toContainText('Which PRs need me?')
  await expect(transcript).toContainText('Three PRs are open.')
  await expect(live).toHaveCount(0)
  await expect(page.getByText('Which PRs need me?')).toHaveCount(1)

  await card.getByRole('button', { name: 'Mute', exact: true }).click()
  await expect(eaItem(page).getByTestId('ea-bar-status')).toHaveText('Mic muted')
  await eaItem(page).getByRole('button', { name: 'Hang up the EA call' }).click()
  await expect(card).toHaveCount(0)
  await expect(call).toBeVisible()
  await expect.poll(async () => botClosed(page)).toBe(true)
})
