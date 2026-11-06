import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, Task } from '@seti/shared'
import { paths } from './env.js'
import { SESSION_PROMPT } from './fake-claude.js'
import { apiData, expect, unique } from './fixtures.js'

/** Starts an agent whose first turn reports its session, and returns its id and session id. */
export async function startSessionAgent(request: APIRequestContext): Promise<{ id: string; session: string }> {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Restart me'), prompt: `Please say ${SESSION_PROMPT}`, cwd: paths.checkout, sandbox: false },
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
