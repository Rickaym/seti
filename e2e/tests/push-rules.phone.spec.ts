import type { Envelope, PermissionPolicy, Task } from '@seti/shared'
import { OUTSIDE_PUSH_PROMPT } from './support/fake-push.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('PushTo is added with taps and fits the phone', async ({ page, request }) => {
  const rule = `PushTo(${unique('acme')})`
  await page.goto('/#settings/permissions')
  const rules = page.getByRole('region', { name: 'Global rules' })
  await rules.getByRole('combobox', { name: 'Rule action' }).selectOption('allow')
  await rules.getByRole('button', { name: 'About pushes elsewhere' }).tap()
  await expect(page.getByText('lets them do it on that owner', { exact: false })).toBeVisible()
  await expectFitsPhone(page, 'PushTo tip')
  await page.keyboard.press('Escape')
  await rules.getByRole('textbox', { name: 'New rule' }).fill(rule)
  await rules.getByRole('button', { name: 'Add' }).tap()
  await expect(rules.getByText(rule, { exact: true })).toBeVisible()
  await expectFitsPhone(page, 'PushTo rule')
  await page.screenshot({ path: test.info().outputPath('push-rule-phone.png'), fullPage: true })

  const policy = await apiData<PermissionPolicy>(request, '/permissions')
  for (const own of policy.rules.filter((r) => r.rule === rule)) {
    await request.delete(`/api/permissions/rules/${String(own.id)}`)
  }
})

test('a push request reads on a phone and Deny stops the push', async ({ page, request }) => {
  const owner = unique('stranger')
  const response = await request.post('/api/tasks', {
    data: { title: unique('Phone pusher'), prompt: `Please ${OUTSIDE_PUSH_PROMPT} ${owner}/tool`, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()

  await page.goto(`/#agents/${id}`)
  const card = page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })
  await expect(card).toContainText(`Push to ${owner}/tool, outside your organisations`)
  await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Always', exact: true })).toBeVisible()
  await expectFitsPhone(page, 'push request')
  await page.screenshot({ path: test.info().outputPath('push-request-phone.png') })
  await card.getByRole('button', { name: 'Deny', exact: true }).tap()
  await expect(page.getByRole('main').getByText('Not pushed:', { exact: false })).toBeVisible()
})
