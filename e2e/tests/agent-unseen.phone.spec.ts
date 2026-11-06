import type { Task } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { startAgent } from './support/many-prs.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a finished agent shows a dot in the phone list until it is opened', async ({ page, request }) => {
  const agent = await startAgent(request, 'Phone dot')
  await page.goto('/#agents')
  const row = page.getByRole('main').locator(`[data-task-id="${agent.id}"]`)
  const dot = row.getByRole('img', { name: 'unseen' })
  await expect(dot).toBeVisible()
  await expectFitsPhone(page, 'agent list with an unseen agent')

  await row.getByRole('button').tap()
  await expect(page.getByRole('combobox', { name: 'Reply' })).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${agent.id}`)).unseen).toBe(false)
  await page.goto('/#agents')
  await expect(row).toBeVisible()
  await expect(dot).toHaveCount(0)
})
