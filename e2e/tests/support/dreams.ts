import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, Revision, Task } from '@seti/shared'
import { apiData, expect, unique } from './fixtures.js'

/** Starts a sandboxed agent and waits until its first turn ended, so it may dream. */
export async function idleAgent(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/tasks', { data: { title: unique('Dreamer'), prompt: 'Please say hello' } })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  return id
}

/** Who made the agent's newest memory change: Seti's dream, or the user's undo. */
export async function lastMemoryActor(request: APIRequestContext, id: string): Promise<string | null> {
  const revisions = await apiData<Revision[]>(request, `/revisions?object_type=memory_file&task_id=${id}`)
  return revisions[0]?.actor ?? null
}

export const dreams = (page: Page) => page.getByRole('group', { name: 'Dreams' })
