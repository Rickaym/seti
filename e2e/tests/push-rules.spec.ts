import type { Page } from '@playwright/test'
import type { AgentPermissions, Envelope, PermissionPolicy, Task } from '@seti/shared'
import { OUTSIDE_PUSH_PROMPT, PUSHED } from './support/fake-push.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const rules = (page: Page) => page.getByRole('region', { name: 'Global rules' })

test('the user adds PushTo(owner) as an allow rule, and only as one', async ({ page, request }) => {
  const rule = `PushTo(${unique('acme')})`
  await page.goto('/#settings/permissions')
  await rules(page).getByRole('combobox', { name: 'Rule action' }).selectOption('deny')
  await rules(page).getByRole('textbox', { name: 'New rule' }).fill(rule)
  await rules(page).getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('PushTo takes one owner and only allows', { exact: false })).toBeVisible()

  await rules(page).getByRole('combobox', { name: 'Rule action' }).selectOption('allow')
  await rules(page).getByRole('button', { name: 'About pushes elsewhere' }).click()
  await expect(page.getByText('lets them do it on that owner', { exact: false })).toBeVisible()
  await page.keyboard.press('Escape')
  await rules(page).getByRole('button', { name: 'Add' }).click()
  const allowed = rules(page).getByRole('group', { name: 'Rules' }).getByRole('region', { name: 'Allow' })
  await expect(allowed).toContainText(rule)
  await page.screenshot({ path: test.info().outputPath('push-rule.png') })

  const policy = await apiData<PermissionPolicy>(request, '/permissions')
  for (const own of policy.rules.filter((r) => r.rule === rule)) {
    await request.delete(`/api/permissions/rules/${String(own.id)}`)
  }
})

test('a push outside the user organisations asks first, and Always adds PushTo', async ({ page, request }) => {
  const owner = unique('stranger')
  const response = await request.post('/api/tasks', {
    data: { title: unique('Pusher'), prompt: `Please ${OUTSIDE_PUSH_PROMPT} ${owner}/tool`, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()

  await page.goto(`/#agents/${id}`)
  const card = page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })
  await expect(card).toContainText(`Push to ${owner}/tool, outside your organisations`)
  await expect(card).toContainText(`Always adds PushTo(${owner})`)
  await page.screenshot({ path: test.info().outputPath('push-request.png') })
  await card.getByRole('button', { name: 'Always', exact: true }).click()
  await expect(page.getByRole('main').getByText(PUSHED, { exact: true })).toBeVisible()
  await expect
    .poll(async () => (await apiData<AgentPermissions>(request, `/tasks/${id}/permissions`)).own.map((r) => r.rule))
    .toContain(`PushTo(${owner})`)
})
