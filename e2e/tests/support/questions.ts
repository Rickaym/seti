import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, MessagePage, Task } from '@seti/shared'
import { paths } from './env.js'
import { apiData, expect, unique } from './fixtures.js'

/** Starts an agent on a question prompt and waits until its questions hold it in Needs you. */
export async function askingAgent(request: APIRequestContext, name: string, prompt: string): Promise<Task> {
  const response = await request.post('/api/tasks', {
    data: { title: unique(name), prompt, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const task = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${task.id}`)).blocked).toMatch(/^Asks /)
  return apiData<Task>(request, `/tasks/${task.id}`)
}

/** The agent's latest reply text, as the fake Claude writes it once its questions come back. */
export async function lastReply(request: APIRequestContext, taskId: string): Promise<string> {
  const { messages } = await apiData<MessagePage>(request, `/tasks/${taskId}/messages?limit=50`)
  const texts = messages.flatMap((row) =>
    row.kind === 'sdk' && row.payload.type === 'assistant'
      ? row.payload.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : [],
  )
  return texts.at(-1) ?? ''
}

/** The text of the agent's latest tool result, as its transcript stored it. */
export async function lastToolResult(request: APIRequestContext, taskId: string): Promise<string> {
  const { messages } = await apiData<MessagePage>(request, `/tasks/${taskId}/messages?limit=50`)
  const results = messages.flatMap((row) => {
    if (row.kind !== 'sdk' || row.payload.type !== 'user') {
      return []
    }
    const { content } = row.payload.message
    return typeof content === 'string'
      ? []
      : content.flatMap((block) =>
          block.type === 'tool_result' && typeof block.content === 'string' ? [block.content] : [],
        )
  })
  return results.at(-1) ?? ''
}

/** The agent's questions on the Questions page. */
export const agentQuestions = (page: Page, task: Task) =>
  page.getByRole('region', { name: `Questions from ${task.title}` })

/** The Questions page's line saying how many are answered, then what Submit all sent. */
export const sentLine = (page: Page) => page.getByRole('main').getByRole('status')
