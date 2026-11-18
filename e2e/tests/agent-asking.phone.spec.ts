import type { Envelope, MessagePage, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { ASK_PROMPT, CHOICE_OPTIONS, CHOICE_PROMPT } from './support/fake-replies.js'
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

test('quick replies fit the phone and send the whole answer on a tap', async ({ page, request }) => {
  const long = CHOICE_OPTIONS[1]
  const response = await request.post('/api/tasks', {
    data: { title: unique('Phone choice'), prompt: `Please ${CHOICE_PROMPT}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).asking).toBe(true)

  await page.goto('/#agents')
  const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${id}"]`)
  await expect(row).toContainText('Asked in its reply')
  await row.getByRole('button').tap()

  const replies = page.getByRole('main').getByRole('group', { name: 'Quick replies' })
  await expect(replies.getByRole('button')).toHaveCount(4)
  for (const button of await replies.getByRole('button').all()) {
    const box = await button.boundingBox()
    expect(box?.height, 'a quick reply is a touch target').toBeGreaterThanOrEqual(44)
  }
  await expectFitsPhone(page, 'quick replies under a question')

  await replies.getByRole('button', { name: `${long.slice(0, 25)}...` }).tap()
  await expect(replies).toHaveCount(0)
  await expect(page.getByRole('main').getByText('Done.', { exact: true })).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).asking).toBe(false)
  const prompts = (await apiData<MessagePage>(request, `/tasks/${id}/messages`)).messages.flatMap((message) =>
    message.kind === 'prompt' ? [message.payload.text] : [],
  )
  expect(prompts.at(-1)).toBe(long)
  await expect(replies).toHaveCount(0)
})
