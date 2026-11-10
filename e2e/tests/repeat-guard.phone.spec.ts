import type { Envelope, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { REPEAT_COMMAND, REPEAT_DONE, REPEAT_PROMPT, REPEAT_REASON } from './support/fake-repeat.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a repeated call fits the phone, is allowed with a tap, and the switch is in reach', async ({ page, request }) => {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Phone loop'), prompt: `Please ${REPEAT_PROMPT}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).toBe(REPEAT_REASON)

  await page.goto('/#agents')
  const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${id}"]`)
  await expect(row).toContainText(REPEAT_REASON)
  await row.getByRole('button').tap()
  const card = page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })
  await expect(card).toContainText(REPEAT_COMMAND)
  await expectFitsPhone(page, 'repeat request')
  await card.getByRole('button', { name: 'Allow', exact: true }).tap()
  await expect(page.getByRole('main').getByText(REPEAT_DONE, { exact: true })).toBeVisible()

  await page.goto('/#settings/agents')
  const guard = page
    .getByRole('main')
    .getByRole('region', { name: 'Repeats' })
    .getByRole('button', { name: 'Ask first' })
  await expect(guard).toHaveAttribute('aria-pressed', 'true')
  await guard.tap()
  await expect(guard).toHaveAttribute('aria-pressed', 'false')
  await guard.tap()
  await expect(guard).toHaveAttribute('aria-pressed', 'true')
  await expectFitsPhone(page, 'Lifecycle')
})
