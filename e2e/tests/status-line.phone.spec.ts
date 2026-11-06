import type { Envelope, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { setiPrompt } from './support/fake-claude.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const STATUS = 'running e2e on the phone projects'

test('an agent status shows on its row in the phone list, and the agent bar leaves it out', async ({
  page,
  request,
}) => {
  const title = unique('Phone status')
  const response = await request.post('/api/tasks', {
    data: { title, prompt: 'Say hello', cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  const prompt = setiPrompt('set_status', { text: STATUS }, { hold: true })
  expect((await request.post(`/api/tasks/${id}/messages`, { data: { prompt } })).ok()).toBe(true)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status_line).toBe(STATUS)

  await page.goto('/#agents')
  const line = page.locator(`[data-task-id="${id}"]`).getByTestId('status-line')
  await expect(line).toHaveText(STATUS)

  await page.goto(`/#agents/${id}`)
  const header = page.getByTestId('agent-header')
  await expect(header.getByRole('img', { name: 'running' })).toBeVisible()
  await expect(header.getByTestId('status-line')).toHaveCount(0)
  await expectFitsPhone(page, 'agent header of an agent with a status line')

  expect((await request.post(`/api/tasks/${id}/stop`, { data: {} })).ok()).toBe(true)
  await page.goto('/#agents')
  await expect(line).toHaveCount(0)
})
