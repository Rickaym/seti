import type { PermissionRequest, PermissionTimeoutSettings, Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { PERMISSION_COMMAND } from './support/fake-permission.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { deployingAgent } from './support/requests.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const MINUTE = 60_000

test.afterEach(async ({ request }) => {
  await request.put('/api/permissions/timeout', { data: { request_timeout_minutes: 60 } })
})

test('the request timeout is set, counts down and denies on a phone', async ({ page, request }) => {
  await page.clock.install()
  await page.goto('/#settings/permissions')
  const timeout = page.getByRole('combobox', { name: 'Request timeout' })
  await expect(timeout).toHaveValue('60')
  await expectFitsPhone(page, 'permissions settings')
  await page.getByRole('button', { name: 'About the request timeout' }).tap()
  await expect(page.getByRole('dialog').filter({ hasText: 'already waiting' })).toBeVisible()
  await page.keyboard.press('Escape')
  await timeout.selectOption({ label: '4 h' })
  const saved = async () =>
    (await apiData<PermissionTimeoutSettings>(request, '/permissions/timeout')).request_timeout_minutes
  await expect.poll(saved).toBe(240)

  const task = await deployingAgent(request, 'Phone timeout')
  await page.goto(`/#agents/${task.id}`)
  const card = page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })
  await expect(card).toContainText(PERMISSION_COMMAND)
  const left = card.getByText(/^denies in /)
  await expect(left).toHaveText(/^denies in (4h 0m|3h 59m)$/)
  await expectFitsPhone(page, 'permission request with its countdown')
  await page.clock.fastForward(200 * MINUTE)
  await expect(left).toHaveText(/^denies in (40m|39m)$/)

  const [pending] = await apiData<PermissionRequest[]>(request, `/tasks/${task.id}/permission-requests`)
  const db = openSeedDb()
  const raised = new Date(Date.parse(pending?.created_at ?? '') - 20 * MINUTE).toISOString()
  await db.run('UPDATE permission_request SET created_at = ? WHERE id = ?', raised, pending?.id ?? '')
  await db.close()
  await page.goto('/#settings/permissions')
  await timeout.selectOption({ label: '15 min' })
  await expect.poll(saved).toBe(15)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${task.id}`)).blocked).toBeNull()

  await page.goto(`/#agents/${task.id}`)
  await expect(card).toHaveCount(0)
  const main = page.getByRole('main')
  await expect(
    main.getByText(/Did not deploy: No answer within 15 min, so Seti denied this automatically/),
  ).toBeVisible()
  await expect(main.getByText('Denied Bash: timed out after 15 min with no answer')).toBeVisible()
  await expectFitsPhone(page, 'transcript with the timed out note')
})
