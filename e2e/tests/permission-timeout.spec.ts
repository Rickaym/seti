import type { APIRequestContext, Page } from '@playwright/test'
import type { PermissionRequest, PermissionTimeoutSettings, Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { PERMISSION_COMMAND } from './support/fake-permission.js'
import { apiData, expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { deployingAgent } from './support/requests.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const MINUTE = 60_000
const card = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })
const timeout = (page: Page) => page.getByRole('combobox', { name: 'Request timeout' })

const savedMinutes = async (request: APIRequestContext) =>
  (await apiData<PermissionTimeoutSettings>(request, '/permissions/timeout')).request_timeout_minutes

/** Makes the agent's pending request look as if it was raised `minutes` ago. */
async function ageRequest(request: APIRequestContext, taskId: string, minutes: number): Promise<void> {
  const [pending] = await apiData<PermissionRequest[]>(request, `/tasks/${taskId}/permission-requests`)
  expect(pending?.state).toBe('pending')
  const db = openSeedDb()
  const raised = new Date(Date.parse(pending?.created_at ?? '') - minutes * MINUTE).toISOString()
  await db.run('UPDATE permission_request SET created_at = ? WHERE id = ?', raised, pending?.id ?? '')
  await db.close()
}

test.afterEach(async ({ request }) => {
  await request.put('/api/permissions/timeout', { data: { request_timeout_minutes: 60 } })
})

test('a request counts down on its card and is denied as timed out once its time is up', async ({ page, request }) => {
  await page.clock.install()
  await page.goto('/#settings/permissions')
  await expect(timeout(page)).toHaveValue('60')
  await page.getByRole('button', { name: 'About the request timeout' }).click()
  await expect(page.getByRole('dialog').filter({ hasText: 'already waiting' })).toContainText(
    'Counts from when each request was raised. A new value applies to requests already waiting, so one older than it is denied at once.',
  )
  await page.keyboard.press('Escape')
  await timeout(page).selectOption({ label: '4 h' })
  await expect.poll(async () => savedMinutes(request)).toBe(240)

  const task = await deployingAgent(request, 'Timeout agent')
  await page.goto(`/#agents/${task.id}`)
  await expect(card(page)).toContainText(PERMISSION_COMMAND)
  const left = card(page).getByText(/^denies in /)
  await expect(left).toHaveText(/^denies in (4h 0m|3h 59m)$/)
  await expect(left).toHaveAttribute('title', /^Seti denies this at .+ if nobody answers\./)
  await page.clock.fastForward(200 * MINUTE)
  await expect(left).toHaveText(/^denies in (40m|39m)$/)

  await ageRequest(request, task.id, 20)
  await page.goto('/#settings/permissions')
  await timeout(page).selectOption({ label: '15 min' })
  await expect.poll(async () => savedMinutes(request)).toBe(15)

  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${task.id}`)).blocked).toBeNull()
  const [denied] = await apiData<PermissionRequest[]>(request, `/tasks/${task.id}/permission-requests`)
  expect(denied).toMatchObject({ state: 'denied', timed_out: true })

  await page.goto(`/#agents/${task.id}`)
  await expect(card(page)).toHaveCount(0)
  const main = page.getByRole('main')
  await expect(
    main.getByText(/Did not deploy: No answer within 15 min, so Seti denied this automatically/),
  ).toBeVisible()
  const note = main.getByText('Denied Bash: timed out after 15 min with no answer')
  await expect(note).toBeVisible()
  await expect(note.locator('time')).toHaveText(/\d{1,2}:\d{2}/)
  await page.goto('/#agents')
  await expect(main.getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${task.id}"]`)).toHaveCount(0)
})
