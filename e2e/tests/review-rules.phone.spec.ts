import type { Envelope, PermissionPolicy, PermissionRule, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { REVIEW_DRAFT, REVIEW_PROMPT, reviewSent } from './support/fake-review.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a review fits the phone, and its message is edited and sent with taps', async ({ page, request }) => {
  const rule = `mcp__${unique('chat').replace(/\W/g, '_')}`
  await page.goto('/#settings/permissions')
  const rules = page.getByRole('region', { name: 'Global rules' })
  await rules.getByRole('combobox', { name: 'Rule action' }).selectOption('review')
  await rules.getByRole('textbox', { name: 'New rule' }).fill(rule)
  await rules.getByRole('button', { name: 'Add' }).tap()
  await expect(rules.getByText(rule, { exact: true })).toBeVisible()
  await expectFitsPhone(page, 'review rule')

  try {
    const response = await request.post('/api/tasks', {
      data: {
        title: unique('Phone notifier'),
        prompt: `Please ${REVIEW_PROMPT} ${rule}__send_message`,
        cwd: paths.checkout,
        sandbox: false,
      },
    })
    expect(response.ok(), 'POST /api/tasks').toBe(true)
    const { id } = ((await response.json()) as Envelope<Task>).data
    await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()

    await page.goto(`/#agents/${id}`)
    const card = page.getByRole('main').getByRole('region', { name: /^Permission request for / })
    const text = card.getByRole('group', { name: 'Call fields' }).getByRole('textbox', { name: 'text' })
    await expect(text).toHaveValue(REVIEW_DRAFT)
    await expectFitsPhone(page, 'review request')
    await text.fill('Deploy is done')
    await card.getByRole('button', { name: 'Allow', exact: true }).tap()
    await expect(page.getByRole('main').getByText(reviewSent('Deploy is done'), { exact: true })).toBeVisible()
  } finally {
    const policy = await apiData<PermissionPolicy>(request, '/permissions')
    for (const own of policy.rules.filter((r: PermissionRule) => r.rule === rule)) {
      await request.delete(`/api/permissions/rules/${String(own.id)}`)
    }
  }
})
