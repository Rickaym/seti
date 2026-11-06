import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { ASK_PROMPT, ASK_REPLY } from './support/fake-claude.js'
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

async function startAsking(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title, prompt: `Please ${ASK_PROMPT}`, cwd: paths.checkout, sandbox: false },
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
  await expect(barItem(page)).toHaveAccessibleName(new RegExp(`^${String(before + 1)} agents? needs? you$`))
  await expect(toasts(page)).toHaveCount(0)

  await row.getByRole('button').click()
  await expect(page.getByRole('main').getByText(ASK_REPLY.split('\n\n')[1] ?? '')).toBeVisible()
  await expect(page.getByRole('main').getByText('asks you', { exact: true })).toBeVisible()
  await expect(row).toHaveCount(0)
  await expect.poll(async () => barCount(page)).toBe(before)

  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('Push main')
  await reply.press('Enter')
  await expect(page.getByRole('main').getByText('Done.', { exact: true })).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  expect((await apiData<Task>(request, `/tasks/${id}`)).asking).toBe(false)
  await expect(page.getByRole('main').getByText('asks you', { exact: true })).toHaveCount(0)
})
