import type { APIRequestContext, Page } from '@playwright/test'
import {
  listedStatus,
  requestCount,
  waitsOnYou,
  type Envelope,
  type PendingRequests,
  type Task,
  type TaskListEntry,
} from '@seti/shared'
import { PERMISSION_PROMPT, PLAN_APPROVAL_PROMPT } from './fake-permission.js'
import { apiData, expect, unique } from './fixtures.js'

/** Starts a fake agent on the prompt and waits until its reason line says what it waits on. */
async function blockedAgent(request: APIRequestContext, name: string, prompt: string, line: RegExp): Promise<Task> {
  const response = await request.post('/api/tasks', {
    data: { title: unique(name), prompt, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const task = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${task.id}`)).blocked).toMatch(line)
  return apiData<Task>(request, `/tasks/${task.id}`)
}

/** An agent whose ExitPlanMode call waits on the user to approve its plan. */
export const planningAgent = async (request: APIRequestContext, name: string) =>
  blockedAgent(request, name, `Please ${PLAN_APPROVAL_PROMPT}`, /^Asks to approve its plan$/)

/** An agent whose Bash call no rule allows waits on the user. */
export const deployingAgent = async (request: APIRequestContext, name: string) =>
  blockedAgent(request, name, `Please ${PERMISSION_PROMPT}`, /^Asks to use Bash/)

const pendingRequests = async (request: APIRequestContext) => apiData<PendingRequests>(request, '/requests')

/** How many requests of every kind wait, as the Requests row counts them. */
export const pendingTotal = async (request: APIRequestContext) => requestCount(await pendingRequests(request))

async function posted(request: APIRequestContext, url: string, data: object): Promise<void> {
  const response = await request.post(`/api${url}`, { data })
  expect(response.ok(), `POST ${url}`).toBe(true)
}

/** Settles, as the user, every pending request of agents besides `keep` that earlier specs left. */
export async function settleOthers(request: APIRequestContext, keep: readonly string[]): Promise<void> {
  const pending = await pendingRequests(request)
  const other = (taskId: string | null) => taskId === null || !keep.includes(taskId)
  const questions = pending.questions.filter((question) => other(question.task_id))
  if (questions.length > 0) {
    await posted(request, '/questions/answers', { items: questions.map(({ id }) => ({ action: 'dismiss', id })) })
  }
  for (const change of pending.access.filter((entry) => other(entry.task_id))) {
    await posted(request, `/tasks/${change.task_id}/change-requests/${change.id}`, { decision: 'deny' })
  }
  for (const call of pending.permissions.filter((entry) => other(entry.task_id))) {
    await posted(request, `/tasks/${call.task_id}/permission-requests/${call.id}`, { decision: 'deny' })
  }
  for (const note of pending.notes.filter((entry) => other(entry.proposer_task_id))) {
    await posted(request, `/knowledge/${note.id}/reject`, {})
  }
}

/** Archives every agent that needs the user besides `keep`, so the status bar counts only those. */
export async function archiveOtherWaiting(request: APIRequestContext, keep: readonly string[]): Promise<void> {
  const tasks = await apiData<TaskListEntry[]>(request, '/tasks')
  const ids = tasks
    .filter((task) => waitsOnYou(task, listedStatus(task)) && !keep.includes(task.id))
    .map((task) => task.id)
  if (ids.length > 0) {
    await posted(request, '/tasks/archive', { task_ids: ids, remove_worktree: false })
  }
}

/** One agent's requests on the Requests page. */
export const requestsGroup = (page: Page, title: string) =>
  page.getByRole('main').getByRole('region', { name: `Requests from ${title}` })

/** The filter by kind above the requests. */
export const kindFilter = (page: Page) => page.getByRole('main').getByRole('group', { name: 'Kinds' })

/** The status bar's count of agents that need the user. */
export const needsYouItem = (page: Page) =>
  page.getByRole('contentinfo').getByRole('button', { name: /agents? needs? you$/ })
