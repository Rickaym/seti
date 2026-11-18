import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, MessagePage, Task, TaskListEntry } from '@seti/shared'
import { paths } from './support/env.js'
import { ASK_PROMPT, ASK_REPLY, CHOICE_OPTIONS, CHOICE_PROMPT, CHOICE_QUESTION } from './support/fake-replies.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV, failureToasts: true })

const needsYou = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Needs you' })
const barItem = (page: Page) => page.getByRole('contentinfo').getByRole('button', { name: /agents? needs? you$/ })

/** The status bar's count of agents that need the user; the item hides while none do. */
async function barCount(page: Page): Promise<number> {
  if ((await barItem(page).count()) === 0) {
    return 0
  }
  return Number((await barItem(page).getAttribute('aria-label'))?.split(' ')[0])
}

async function startAsking(request: APIRequestContext, title: string, prompt = ASK_PROMPT): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title, prompt: `Please ${prompt}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  return id
}

test('an agent whose turn ends on a question joins Needs you until the user opens it', async ({ page, request }) => {
  await page.goto('/#agents')
  await expect(page.getByRole('main').getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  const before = await barCount(page)
  const title = unique('Asking agent')
  const id = await startAsking(request, title)
  expect((await apiData<Task>(request, `/tasks/${id}`)).asking).toBe(true)

  const row = needsYou(page).locator(`[data-task-id="${id}"]`)
  await expect(row).toBeVisible()
  await expect(row.getByRole('img', { name: 'asks you' })).toBeVisible()
  await expect(row).toContainText('Asked in its reply')
  await expect(barItem(page)).toHaveAccessibleName(new RegExp(`^${String(before + 1)} agents? needs? you$`))
  await expect(toasts(page)).toHaveCount(0)

  await row.getByRole('button').click()
  await expect(page.getByRole('main').getByText(ASK_REPLY.split('\n\n')[1] ?? '')).toBeVisible()
  await expect(page.getByRole('main').getByText('asks you', { exact: true })).toBeVisible()
  await expect(row).toHaveCount(0)
  await expect.poll(async () => barCount(page)).toBe(before)

  await expect(page.getByRole('main').getByRole('group', { name: 'Quick replies' })).toHaveCount(0)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('Push main')
  await reply.press('Enter')
  await expect(page.getByRole('main').getByText('Done.', { exact: true })).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  expect((await apiData<Task>(request, `/tasks/${id}`)).asking).toBe(false)
  await expect(page.getByRole('main').getByText('asks you', { exact: true })).toHaveCount(0)
})

test('quick replies answer a question asked in a reply, then go away', async ({ page, request }) => {
  const [short, long] = CHOICE_OPTIONS
  const title = unique('Choice agent')
  const id = await startAsking(request, title, CHOICE_PROMPT)
  const listed = (await apiData<TaskListEntry[]>(request, '/tasks')).find((task) => task.id === id)
  expect(listed).toMatchObject({ asking: true, question: CHOICE_QUESTION })

  await page.goto('/#agents')
  const row = needsYou(page).locator(`[data-task-id="${id}"]`)
  await expect(row).toContainText('Asked in its reply')
  await row.getByRole('button').click()

  const replies = page.getByRole('main').getByRole('group', { name: 'Quick replies' })
  await expect(replies.getByRole('button')).toHaveText(['Yes', 'No', short, `${long.slice(0, 25)}...`])
  await replies.getByRole('button', { name: `${long.slice(0, 25)}...` }).hover()
  await expect(page.getByRole('tooltip')).toHaveText(`Sends "${long}" as your reply`)

  await replies.getByRole('button', { name: 'Yes' }).click()
  await expect(replies).toHaveCount(0)
  await expect(page.getByRole('main').getByText('Done.', { exact: true })).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  const after = (await apiData<TaskListEntry[]>(request, '/tasks')).find((task) => task.id === id)
  expect(after).toMatchObject({ asking: false, question: null })
  const prompts = (await apiData<MessagePage>(request, `/tasks/${id}/messages`)).messages.flatMap((message) =>
    message.kind === 'prompt' ? [message.payload.text] : [],
  )
  expect(prompts.at(-1)).toBe('Yes')
  await expect(replies).toHaveCount(0)
})
