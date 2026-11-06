import type { Envelope, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { ASK_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('an agent asking a question sits in Needs you on the phone and says so in its header', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Phone asking'), prompt: `Please ${ASK_PROMPT}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).asking).toBe(true)

  await page.goto('/#agents')
  const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${id}"]`)
  await expect(row.getByRole('img', { name: 'asks you' })).toBeVisible()
  await row.getByRole('button').tap()
  const header = page.getByTestId('agent-header')
  await expect(header.getByRole('img', { name: 'asks you' })).toBeVisible()
  await expectFitsPhone(page, 'agent asking a question')
})
