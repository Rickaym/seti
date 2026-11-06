import type { Envelope, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { PERMISSION_COMMAND, PERMISSION_DONE, PERMISSION_PROMPT } from './support/fake-permission.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a permission request fits the phone and is answered with a tap', async ({ page, request }) => {
  const response = await request.post('/api/tasks', {
    data: {
      title: unique('Phone permission'),
      prompt: `Please ${PERMISSION_PROMPT}`,
      cwd: paths.checkout,
      sandbox: false,
    },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()

  await page.goto('/#agents')
  const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${id}"]`)
  await row.getByRole('button').tap()
  const card = page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })
  await expect(card).toContainText(PERMISSION_COMMAND)
  await expectFitsPhone(page, 'permission request')
  await card.getByRole('button', { name: 'Allow', exact: true }).tap()
  await expect(page.getByRole('main').getByText(PERMISSION_DONE, { exact: true })).toBeVisible()
})
