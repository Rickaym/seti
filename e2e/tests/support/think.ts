import type { APIRequestContext, Page } from '@playwright/test'
import type { EaLlmMessage } from '@seti/shared'
import { EA_HEADERS } from './env.js'
import type { FakeChat } from './fake-ea.js'
import { expect } from './fixtures.js'

const QUESTION = 'Which PR should I merge first?'
const ANSWER = "Right, here's what I'd do: merge PR 12 first, since it unblocks the dashboard."

export const thinkingLine = (page: Page) => page.getByRole('status', { name: 'Thinking' })

async function store(request: APIRequestContext, messages: EaLlmMessage[]): Promise<number[]> {
  const entries = messages.map((message) => ({ kind: 'chat', message }))
  const response = await request.post('/api/ea/history/messages', { headers: EA_HEADERS, data: { entries } })
  expect(response.ok(), 'POST /api/ea/history/messages').toBe(true)
  return ((await response.json()) as { data: { ids: number[] } }).data.ids
}

/** Types a question the EA thinks through; the Thinking line shows its progress, then the answer. */
export async function askToThink(
  page: Page,
  chat: FakeChat,
  request: APIRequestContext,
  send: (text: string) => Promise<void>,
): Promise<void> {
  const transcript = page.getByRole('main').getByRole('region', { name: 'Transcript' })
  await send(QUESTION)
  const asked = await chat.next()
  expect(asked.text).toBe(QUESTION)

  asked.send({ type: 'tool', id: 't1', name: 'think', arguments: { question: QUESTION } })
  asked.send({ type: 'thinking', text: 'Weighing it up.' })
  await expect(thinkingLine(page)).toContainText('Thinking')
  await expect(thinkingLine(page)).toContainText('Weighing it up.')
  asked.send({ type: 'thinking', text: "I'm going through the open PRs." })
  await expect(thinkingLine(page)).toContainText("I'm going through the open PRs.")
  await expect(page.getByRole('button', { name: 'Stop the reply' })).toBeVisible()

  const result = `Spoken answer: Merge PR 12 first.`
  asked.send({ type: 'thinking', text: null })
  await expect(thinkingLine(page)).toHaveCount(0)
  asked.send({ type: 'tool_result', id: 't1', name: 'think', summary: 'Merge PR 12 first.', ok: true, text: result })
  asked.send({ type: 'text', delta: ANSWER })
  await expect(transcript).toContainText(ANSWER)

  const ids = await store(request, [
    { role: 'user', content: QUESTION },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'think', arguments: JSON.stringify({ question: QUESTION }) } },
      ],
    },
    { role: 'tool', tool_call_id: 't1', content: JSON.stringify(result) },
    { role: 'assistant', content: ANSWER },
  ])
  asked.send({ type: 'done', ids })
  asked.end()
  await expect(page.getByRole('button', { name: 'Stop the reply' })).toHaveCount(0)
  await expect(transcript.locator(`[data-message-id="${String(ids[0])}"]`)).toContainText(QUESTION)
  await expect(transcript.getByText(ANSWER)).toHaveCount(1)
}
