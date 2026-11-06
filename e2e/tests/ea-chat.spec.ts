import type { APIRequestContext, Page } from '@playwright/test'
import { EA_CONFIRM_QUESTION, type AuditPage, type EaHealth, type EaHistoryPage, type EaLlmMessage } from '@seti/shared'
import { EA_HEADERS } from './support/env.js'
import { fakeEaChat, type FakeChat } from './support/fake-ea.js'
import { apiData, expect, nextApiResponse, test, toasts } from './support/fixtures.js'

const READY: EaHealth = {
  ok: true,
  configured: true,
  missing: [],
  model: 'gpt-4.1-mini',
  text_model: 'gpt-4.1',
  chat_missing: [],
  turn: true,
}
const BOT = EA_HEADERS

type Kind = 'message' | 'chat' | 'call'

async function store(request: APIRequestContext, entries: { kind: Kind; message: EaLlmMessage }[]) {
  const response = await request.post('/api/ea/history/messages', { headers: BOT, data: { entries } })
  expect(response.ok(), 'POST /api/ea/history/messages').toBe(true)
  return ((await response.json()) as { data: { ids: number[] } }).data.ids
}

const turn = (kind: Kind, role: 'user' | 'assistant', content: string) => ({
  kind,
  message: { role, content } as EaLlmMessage,
})

const main = (page: Page) => page.getByRole('main')
const composer = (page: Page) => page.getByRole('combobox', { name: 'Message the EA' })
const transcript = (page: Page) => main(page).getByRole('region', { name: 'Transcript' })

let chat: FakeChat | null = null

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/ea/history')).ok()).toBe(true)
})

test.afterEach(async ({ request }) => {
  await chat?.close()
  chat = null
  await request.delete('/api/ea/history')
})

async function openChat(page: Page): Promise<FakeChat> {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  chat = await fakeEaChat(page)
  await page.goto('/#agents')
  await page.keyboard.press('Alt+1')
  await expect(page).toHaveURL(/#ea$/)
  await expect(main(page).getByRole('heading', { name: 'EA', level: 1 })).toBeVisible()
  return chat
}

test('a typed message streams its reply with tool rows, then shows as stored', async ({ page, request }) => {
  const bot = await openChat(page)
  await expect(main(page)).toContainText('Nothing said yet')

  await composer(page).fill('What is running right now?')
  await composer(page).press('Enter')
  const asked = await bot.next()
  expect(asked.text).toBe('What is running right now?')
  expect(asked.timezone).toBe('Europe/Berlin')
  await expect(composer(page)).toHaveValue('')
  await expect(transcript(page)).toContainText('What is running right now?')

  asked.send({ type: 'tool', id: 'c1', name: 'list_tasks', arguments: { status: 'running' } })
  const tool = transcript(page).locator('details').filter({ hasText: 'list_tasks' })
  await expect(tool).toBeVisible()
  await expect(tool.getByTestId('tool-running')).toBeVisible()
  asked.send({
    type: 'tool_result',
    id: 'c1',
    name: 'list_tasks',
    summary: 'Listed 1 task',
    ok: true,
    text: '1 task: login.',
  })
  await expect(tool.getByTestId('tool-running')).toHaveCount(0)
  asked.send({ type: 'text', delta: 'One task is ' })
  await expect(transcript(page)).toContainText('One task is')
  await expect(page.getByRole('button', { name: 'Stop the reply' })).toBeVisible()
  asked.send({ type: 'text', delta: '**running**.' })
  await expect(transcript(page).locator('strong', { hasText: 'running' })).toBeVisible()

  const ids = await store(request, [
    turn('chat', 'user', 'What is running right now?'),
    {
      kind: 'chat',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'list_tasks', arguments: '{"status":"running"}' } },
        ],
      },
    },
    { kind: 'chat', message: { role: 'tool', tool_call_id: 'c1', content: '"1 task: login."' } },
    turn('chat', 'assistant', 'One task is **running**.'),
  ])
  asked.send({ type: 'done', ids })
  asked.end()
  await expect(page.getByRole('button', { name: 'Stop the reply' })).toHaveCount(0)
  await expect(transcript(page).locator(`[data-message-id="${String(ids[0])}"]`)).toContainText(
    'What is running right now?',
  )
  await expect(transcript(page).getByText('What is running right now?')).toHaveCount(1)
  await tool.locator('summary').click()
  await expect(tool).toContainText('1 task: login.')
  await expect(transcript(page).locator('[data-voice]')).toHaveCount(0)
})

test('Esc stops a reply and the chat keeps what the EA had said', async ({ page, request }) => {
  const bot = await openChat(page)
  await composer(page).fill('Plan my afternoon.')
  await composer(page).press('Enter')
  const asked = await bot.next()
  asked.send({ type: 'text', delta: 'First, the login fix' })
  await expect(transcript(page)).toContainText('First, the login fix')

  await page.keyboard.press('Escape')
  await asked.closed
  await store(request, [turn('chat', 'user', 'Plan my afternoon.'), turn('chat', 'assistant', 'First, the login fix')])
  await expect(page.getByRole('button', { name: 'Stop the reply' })).toHaveCount(0)
  await expect(transcript(page)).toContainText('First, the login fix')
  await expect(composer(page)).toHaveValue('')
})

test('spoken turns are marked, a question to act offers yes, and a draft survives leaving', async ({
  page,
  request,
}) => {
  await store(request, [
    { kind: 'call', message: { role: 'developer', content: 'A new call started.' } },
    turn('message', 'user', 'Anything on fire?'),
    turn('message', 'assistant', 'Nothing on fire.'),
    turn('chat', 'user', 'Stop the login task.'),
    turn('chat', 'assistant', `That stops Fix the login redirect mid-turn. ${EA_CONFIRM_QUESTION}`),
  ])
  const bot = await openChat(page)
  await expect(transcript(page).locator('[data-note]')).toHaveText([/Call started/i])
  const spoken = transcript(page).locator('[data-voice]')
  await expect(spoken).toHaveCount(2)
  await expect(spoken.first()).toContainText('Anything on fire?')
  await expect(spoken.getByRole('img', { name: 'Spoken on a call' })).toHaveCount(2)

  await composer(page).fill('Remember the demo at four')
  await page.getByRole('complementary').getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(page).toHaveURL(/#agents$/)
  await page.getByRole('complementary').getByRole('button', { name: 'EA', exact: true }).click()
  await expect(composer(page)).toHaveValue('Remember the demo at four')
  await page.reload()
  await expect(composer(page)).toHaveValue('Remember the demo at four')

  const answer = main(page).getByRole('group', { name: 'Answer' })
  await answer.getByRole('button', { name: 'Yes' }).click()
  const yes = await bot.next()
  expect(yes.text).toBe('Yes, go ahead.')
  await expect(answer).toHaveCount(0)
  await expect(composer(page)).toHaveValue('Remember the demo at four')
  yes.send({ type: 'error', title: 'The EA could not answer', detail: 'model unavailable' })
  yes.end()
  await expect(page.getByRole('button', { name: 'Stop the reply' })).toHaveCount(0)
  // The toast covers the New conversation button and stays while the pointer rests on it.
  const failed = toasts(page).filter({ hasText: 'The EA could not answer' })
  await failed.getByRole('button', { name: 'Close toast' }).click()
  await expect(failed).toHaveCount(0)

  await expect(main(page).getByRole('button', { name: 'New conversation' })).toHaveText('New')
  await main(page).getByRole('button', { name: 'New conversation' }).click()
  const cleared = nextApiResponse(page, 'DELETE', '/ea/history')
  await page
    .getByRole('dialog', { name: 'Start a new conversation?' })
    .getByRole('button', { name: 'Forget it' })
    .click()
  await expect(main(page)).toContainText('Nothing said yet')
  expect((await cleared).ok()).toBe(true)
  expect((await apiData<EaHistoryPage>(request, '/ea/history')).entries).toEqual([])
  const audit = await apiData<AuditPage>(request, '/audit?kind=ea.history_cleared&limit=1')
  expect(audit.events[0]).toMatchObject({ actor: 'user', summary: 'Started a new EA conversation' })
})

test('with the EA down the chat stays readable and says how to start it', async ({ page, request }) => {
  await store(request, [turn('chat', 'user', 'Earlier question?'), turn('chat', 'assistant', 'Earlier answer.')])
  await page.goto('/#ea')
  await expect(main(page).getByRole('region', { name: 'EA setup' })).toContainText('The EA is not running')
  await expect(transcript(page)).toContainText('Earlier answer.')
  await composer(page).fill('Are you there?')
  await composer(page).press('Enter')
  await expect(composer(page)).toHaveValue('Are you there?')
  await expect(main(page)).toContainText('The EA cannot answer until it is set up.')
})
