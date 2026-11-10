import type { APIRequestContext, Page } from '@playwright/test'
import type { AutoArchiveStatus, Envelope, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { REPEAT_COMMAND, REPEAT_DONE, REPEAT_PROMPT, REPEAT_REASON } from './support/fake-repeat.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const needsYou = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Needs you' })
const card = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })
const guard = (page: Page) =>
  page.getByRole('main').getByRole('region', { name: 'Repeats' }).getByRole('button', { name: 'Ask first' })

async function startLooping(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title, prompt: `Please ${REPEAT_PROMPT}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  return ((await response.json()) as Envelope<Task>).data.id
}

test('an agent that repeats a call with the same result waits in Needs you until allowed', async ({
  page,
  request,
}) => {
  const id = await startLooping(request, unique('Looping agent'))
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).toBe(REPEAT_REASON)

  await page.goto('/#agents')
  const row = needsYou(page).locator(`[data-task-id="${id}"]`)
  await expect(row).toContainText(REPEAT_REASON)
  await row.getByRole('button').click()

  await expect(card(page)).toContainText(REPEAT_COMMAND)
  await expect(card(page)).toContainText(REPEAT_REASON)
  await expect(card(page).getByRole('button', { name: 'Always' })).toBeVisible()
  await expect(card(page).getByRole('switch', { name: 'All agents' })).toHaveCount(0)
  await card(page).getByRole('button', { name: 'Allow', exact: true }).click()

  await expect(card(page)).toHaveCount(0)
  await expect(page.getByRole('main').getByText(REPEAT_DONE, { exact: true })).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  await expect(row).toHaveCount(0)
})

test('turning Ask first off in Lifecycle lets the agent repeat without asking', async ({ page, request }) => {
  await page.goto('/#settings/agents')
  await expect(guard(page)).toHaveAttribute('aria-pressed', 'true')
  await guard(page).click()
  await expect(guard(page)).toHaveAttribute('aria-pressed', 'false')
  try {
    expect((await apiData<AutoArchiveStatus>(request, '/archive/settings')).settings.repeat_guard).toBe(false)
    const id = await startLooping(request, unique('Unguarded agent'))
    await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
    await page.goto(`/#agents/${id}`)
    await expect(page.getByRole('main').getByText(REPEAT_DONE, { exact: true })).toBeVisible()
    await expect(card(page)).toHaveCount(0)
  } finally {
    await page.goto('/#settings/agents')
    await guard(page).click()
    await expect(guard(page)).toHaveAttribute('aria-pressed', 'true')
  }
})
