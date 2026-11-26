import type { Page } from '@playwright/test'
import type { Envelope, PermissionPolicy, PermissionRequest, Task } from '@seti/shared'
import { REVIEW_DRAFT, REVIEW_PROMPT, reviewSent } from './support/fake-review.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const server = () => `mcp__${unique('chat').replace(/\W/g, '_')}`

const rules = (page: Page) => page.getByRole('region', { name: 'Global rules' })

test('a review rule holds an MCP call until the user edits and allows it', async ({ page, request }) => {
  const rule = server()
  const tool = `${rule}__send_message`
  await page.goto('/#settings/permissions')
  await rules(page).getByRole('combobox', { name: 'Rule action' }).selectOption('review')
  await rules(page).getByRole('textbox', { name: 'New rule' }).fill('Bash')
  await rules(page).getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('use Ask for other tools such as Bash', { exact: false })).toBeVisible()
  await rules(page).getByRole('textbox', { name: 'New rule' }).fill(rule)
  await rules(page).getByRole('button', { name: 'Add' }).click()
  await expect(rules(page).getByRole('group', { name: 'Rules' }).getByRole('region', { name: 'Review' })).toContainText(
    rule,
  )

  try {
    const response = await request.post('/api/tasks', {
      data: {
        title: unique('Notifier'),
        prompt: `Please ${REVIEW_PROMPT} ${tool}`,
        sandbox: false,
      },
    })
    expect(response.ok(), 'POST /api/tasks').toBe(true)
    const { id } = ((await response.json()) as Envelope<Task>).data
    await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()

    await page.goto(`/#agents/${id}`)
    const card = page.getByRole('main').getByRole('region', { name: /^Permission request for / })
    await expect(card).toContainText('Review')
    await expect(card.getByRole('button', { name: 'Always' })).toHaveCount(0)
    const text = card.getByRole('group', { name: 'Call fields' }).getByRole('textbox', { name: 'text' })
    await expect(text).toHaveValue(REVIEW_DRAFT)
    await text.fill('Deploy is done')
    await expect(card).toContainText('Allow runs it with your edits to text; Deny shows the agent your edits.')
    await card.getByRole('button', { name: 'Allow', exact: true }).click()

    await expect(page.getByRole('main').getByText(reviewSent('Deploy is done'), { exact: true })).toBeVisible()
    const edited = page.getByRole('main').getByRole('img', { name: /^Edited: / })
    await expect(edited).toHaveText('Edited')
    await expect(edited).toHaveAccessibleName('Edited: You edited text before the call ran; the agent was told')
    await edited.hover()
    await expect(page.getByRole('tooltip')).toContainText('You edited text before the call ran')
    await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  } finally {
    const policy = await apiData<PermissionPolicy>(request, '/permissions')
    for (const own of policy.rules.filter((r) => r.rule === rule)) {
      await request.delete(`/api/permissions/rules/${String(own.id)}`)
    }
  }
})

test('a held call the user edits and then denies is marked Edited and tells the agent', async ({ page, request }) => {
  const rule = server()
  const added = await request.post('/api/permissions/rules', { data: { behavior: 'review', rule } })
  expect(added.ok(), 'POST /api/permissions/rules').toBe(true)
  try {
    const response = await request.post('/api/tasks', {
      data: { title: unique('Notifier'), prompt: `Please ${REVIEW_PROMPT} ${rule}__send_message`, sandbox: false },
    })
    const { id } = ((await response.json()) as Envelope<Task>).data
    await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()

    await page.goto(`/#agents/${id}`)
    const card = page.getByRole('main').getByRole('region', { name: /^Permission request for / })
    await card.getByRole('group', { name: 'Call fields' }).getByRole('textbox', { name: 'text' }).fill('Deploy is done')
    await card.getByRole('textbox', { name: 'Note for the agent if you deny' }).fill('Wait for QA')
    await card.getByRole('button', { name: 'Deny' }).click()

    await expect(page.getByRole('main').getByText('Not sent.', { exact: true })).toBeVisible()
    const edited = page.getByRole('main').getByRole('img', { name: /^Edited: / })
    await expect(edited).toHaveAccessibleName('Edited: You edited text, then denied the call; the agent got your text')
    const [held] = await apiData<PermissionRequest[]>(request, `/tasks/${id}/permission-requests`)
    expect(held).toMatchObject({ state: 'denied', edited: ['text'], message: 'Wait for QA' })
  } finally {
    const policy = await apiData<PermissionPolicy>(request, '/permissions')
    for (const own of policy.rules.filter((r) => r.rule === rule)) {
      await request.delete(`/api/permissions/rules/${String(own.id)}`)
    }
  }
})
