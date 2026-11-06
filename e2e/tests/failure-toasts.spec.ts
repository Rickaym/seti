import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { FAIL_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV, failureToasts: true })

/** Sonner's own toasts time out after four seconds; failure toasts must outlast that. */
const PAST_A_NORMAL_TOAST_MS = 6000

async function failAgent(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title, prompt: `Please ${FAIL_PROMPT} rate limit reached ${title}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('error')
  return id
}

const toastOf = (page: Page, text: string) => toasts(page).filter({ hasText: text })

/** Fails one more agent and waits for its toast, so a toast that is missing by then never comes. */
async function anotherFailure(page: Page, request: APIRequestContext): Promise<void> {
  const title = unique('Toast control')
  await failAgent(request, title)
  await expect(toastOf(page, title)).toBeVisible()
}

test('a failure stays as a toast until acted on, and Open goes to the agent', async ({ page, request }) => {
  await page.clock.install()
  await page.goto('/#context')
  const title = unique('Toast open')
  const id = await failAgent(request, title)

  const toast = toastOf(page, title)
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('Rate limit reached.')
  await page.clock.fastForward(PAST_A_NORMAL_TOAST_MS)
  await expect(toast).toBeVisible()

  await toast.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
  await expect(toast).toHaveCount(0)
  await page.goto('/#context')
  await page.reload()
  await anotherFailure(page, request)
  await expect(toastOf(page, title)).toHaveCount(0)
})

test('Dismiss sticks across a reload, and the agent still needs you', async ({ page, request }) => {
  await page.goto('/#agents')
  const title = unique('Toast dismiss')
  await failAgent(request, title)

  const toast = toastOf(page, title)
  await toast.getByRole('button', { name: 'Dismiss' }).click()
  await expect(toast).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('main').getByRole('region', { name: 'Needs you' })).toContainText(title)
  await anotherFailure(page, request)
  await expect(toastOf(page, title)).toHaveCount(0)
})

test('several failures collapse into one toast with a way to the list', async ({ page, request }) => {
  await page.goto('/#context')
  const prefix = unique('Toast many')
  for (const n of [1, 2, 3]) {
    await failAgent(request, `${prefix} ${String(n)}`)
  }

  const summary = toastOf(page, '3 agents failed')
  await expect(summary).toBeVisible()
  await expect(summary).toContainText(`${prefix} 3`)
  await expect(toasts(page).filter({ hasText: prefix })).toHaveCount(1)
  await summary.getByRole('button', { name: 'Open list' }).click()
  await expect(page).toHaveURL(/#agents$/)
  await expect(page.getByRole('main').getByRole('region', { name: 'Needs you' })).toContainText(`${prefix} 1`)
  await page.reload()
  await anotherFailure(page, request)
  await expect(toasts(page).filter({ hasText: prefix })).toHaveCount(0)
})

test('no toast for the agent on screen when it fails', async ({ page, request }) => {
  const id = randomUUID()
  const title = unique('Toast open agent')
  const db = openSeedDb()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.run(`UPDATE task SET sandbox = 0 WHERE id = ?`, id)
  await db.close()

  await page.goto(`/#agents/${id}`)
  const sent = await request.post(`/api/tasks/${id}/messages`, { data: { prompt: `Please ${FAIL_PROMPT} quota` } })
  expect(sent.ok()).toBe(true)
  await expect(page.getByRole('main').getByRole('region', { name: 'Turn failed' })).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).unseen).toBe(false)
  await expect(page.getByRole('main').locator(`[data-task-id="${id}"]`)).toBeVisible()
  await expect(
    page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${id}"]`),
  ).toHaveCount(0)
  await page.goto('/#agents')
  await anotherFailure(page, request)
  await expect(toastOf(page, title)).toHaveCount(0)
})
