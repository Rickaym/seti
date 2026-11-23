import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { Envelope, MessagePage, Task } from '@seti/shared'
import { apiData, expect, toasts, unique } from './fixtures.js'

/** Starts an agent on a question prompt and waits until its questions hold it in Needs you. */
export async function askingAgent(request: APIRequestContext, name: string, prompt: string): Promise<Task> {
  const response = await request.post('/api/tasks', {
    data: { title: unique(name), prompt, sandbox: false },
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

/** The agent's questions on the Requests page. */
export const agentQuestions = (page: Page, task: Task) =>
  page.getByRole('region', { name: `Questions from ${task.title}` })

/** The Requests page's line saying how many are answered, then what Submit all sent. */
export const sentLine = (page: Page) => page.getByRole('main').getByRole('status')

/** The Requests drawer beside an agent, which holds only that agent's requests. */
export const requestsDrawer = (page: Page) => page.getByRole('region', { name: 'Agent requests' })

/** A send raises no toast: the questions leave and the agent goes on. */
export async function expectNoSentToast(page: Page): Promise<void> {
  await expect(toasts(page).filter({ hasText: /Sent \d+ answer|dismissed \d+ question/ })).toHaveCount(0)
}

/** The Requests row in the sidebar, or in the phone menu while it is open. */
export const requestsSection = (page: Page) =>
  page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Requests', exact: true })

/** The number a section's row shows, absent while it counts nothing. */
export const sectionCount = (row: Locator) => row.locator('[data-section-count] > [aria-hidden="true"]')

/** Opens the phone menu and taps Requests in it. */
export async function openRequestsFromMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Menu' }).tap()
  await requestsSection(page).tap()
}
