import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, MessagePage, Task } from '@seti/shared'
import { paths } from './env.js'
import { HOLD_PROMPT, SESSION_PROMPT } from './fake-claude.js'
import { apiData, expect, unique } from './fixtures.js'

/** Starts an agent whose first turn reports its session, and returns its id and session id. */
export async function startSessionAgent(request: APIRequestContext): Promise<{ id: string; session: string }> {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Restart me'), prompt: `Please say ${SESSION_PROMPT}`, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  const sessionOf = async () => {
    const task = await apiData<Task>(request, `/tasks/${id}`)
    return task.status === 'idle' ? task.session_id : null
  }
  await expect.poll(sessionOf).not.toBeNull()
  return { id, session: (await sessionOf()) ?? '' }
}

export const transcript = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Transcript' })

/** What Seti tells an agent it resumes after a restart, and the transcript's mark on that turn. */
export const RESUME_PROMPT = 'Seti restarted while you were working. Continue where you left off'
export const RESUMED_NOTE = 'Seti restarted during this turn and resumed it'

/** Starts an agent whose turn keeps working, and returns its id once the turn is under way. */
export async function startWorkingAgent(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Cut off'), prompt: `Please ${HOLD_PROMPT}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  const working = async () => {
    const { messages } = await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=50`)
    return messages.some((row) => row.kind === 'sdk' && row.payload.type === 'assistant')
  }
  await expect.poll(working).toBe(true)
  return id
}
