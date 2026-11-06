import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { setiPrompt } from './support/fake-claude.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const STATUS = 'waiting on CI for the dashboard reconnection e2e suite'

async function startAgent(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title, prompt: 'Say hello', cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  return id
}

/** Has the agent set its status with the seti tool and keep its turn running. */
async function setStatus(request: APIRequestContext, id: string): Promise<void> {
  const prompt = setiPrompt('set_status', { text: STATUS }, { hold: true })
  expect((await request.post(`/api/tasks/${id}/messages`, { data: { prompt } })).ok()).toBe(true)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status_line).toBe(STATUS)
}

const row = (page: Page, id: string) => page.locator(`[data-task-id="${id}"]`)

test('an agent status shows on its row and its headers, whole on hover, and clears when the turn ends', async ({
  page,
  request,
}) => {
  const title = unique('Status line')
  const id = await startAgent(request, title)
  await page.goto(`/#agents/${id}`)
  await expect(row(page, id).getByTestId('status-line')).toHaveCount(0)
  await setStatus(request, id)

  const inRow = row(page, id).getByTestId('status-line')
  await expect(inRow).toHaveText(STATUS)
  expect(await inRow.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await expect(row(page, id).getByRole('button')).toHaveAttribute('title', new RegExp(`${STATUS}$`))

  const inHeader = page.locator('[data-testid="status-line"]:not([data-task-id] *)')
  await expect(inHeader).toHaveText(STATUS)
  await inHeader.hover()
  await expect(page.getByRole('tooltip')).toHaveText(STATUS)

  await page.getByRole('button', { name: 'Open in grid' }).click()
  const panel = page.locator('[data-grid-item]').filter({ has: page.getByRole('heading', { name: title }) })
  const inCell = panel.getByTestId('agent-header').getByTestId('status-line')
  await expect(inCell).toHaveText(STATUS)
  await inCell.hover()
  await expect(page.getByRole('tooltip')).toHaveText(STATUS)

  expect((await request.post(`/api/tasks/${id}/stop`, { data: {} })).ok()).toBe(true)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status_line).toBeNull()
  await expect(inRow).toHaveCount(0)
  await expect(inCell).toHaveCount(0)
})
