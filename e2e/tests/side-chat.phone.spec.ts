import type { MessagePage, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { HOLD_PROMPT } from './support/fake-claude.js'
import { SIDE_ANSWER, SLOW_QUESTION } from './support/fake-side-chat.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { startAgent } from './support/grid.js'
import { setModEnabled } from './support/mods.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { seedSession, sideChat } from './support/side-chat.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('Ask aside opens a bottom sheet that answers, fits the phone and keeps the chat on close', async ({
  page,
  request,
}) => {
  const id = await startAgent(request, unique('Phone side chat'))
  await seedSession(id)
  const rows = async () =>
    (await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=200`)).messages.map((row) => row.id)
  const before = await rows()

  await page.goto(`/#agents/${id}`)
  const openAsk = async () => {
    await page.getByTestId('agent-header').getByRole('button', { name: 'More actions' }).tap()
    const row = page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Ask aside' })
    await expect(row).toContainText('/btw')
    await row.tap()
  }
  await openAsk()
  const sheet = sideChat(page)
  await expect(sheet).toBeVisible()
  await expectFitsPhone(page, 'side chat sheet')
  const [box, main] = await Promise.all([sheet.boundingBox(), page.getByRole('main').boundingBox()])
  const bottom = (b: typeof box) => Math.round((b?.y ?? 0) + (b?.height ?? 0))
  expect(Math.abs(bottom(box) - bottom(main))).toBeLessThanOrEqual(2)
  expect(Math.round(box?.width ?? 0)).toBe(page.viewportSize()?.width)

  const field = sheet.getByRole('textbox', { name: 'Side question' })
  await field.fill('why this approach?')
  await sheet.getByRole('button', { name: 'Ask', exact: true }).tap()
  await expect(sheet.locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Send to agent' })).toBeVisible()
  await expectFitsPhone(page, 'side chat sheet with an answer')
  expect(await rows()).toEqual(before)

  await field.fill(SLOW_QUESTION)
  await sheet.getByRole('button', { name: 'Ask', exact: true }).tap()
  await expect(sheet.getByTestId('side-chat-exchange').nth(1)).toContainText(SIDE_ANSWER)
  await field.fill('and one more?')
  await expect(sheet.getByRole('status', { name: 'Side chat status' })).toContainText('still answering')
  await expect(sheet.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled()
  await expectFitsPhone(page, 'side chat sheet holding a question')
  await expect(
    sheet.getByTestId('side-chat-exchange').nth(1).getByRole('button', { name: 'Send to agent' }),
  ).toBeVisible()
  await sheet.getByRole('button', { name: 'Ask', exact: true }).tap()
  await expect(sheet.getByTestId('side-chat-exchange').nth(2)).toContainText('about and one more?')
  await expect(field).toHaveValue('')

  await sheet.getByRole('button', { name: 'Close side chat' }).tap()
  await expect(sheet).toHaveCount(0)
  await openAsk()
  await expect(sideChat(page).getByTestId('side-chat-exchange')).toHaveCount(3)
})

test('/btw in the reply box asks mid-turn in the side chat sheet and sends nothing to the agent', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Phone btw'), prompt: `Please ${HOLD_PROMPT}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok()).toBe(true)
  const { id } = ((await response.json()) as { data: Task }).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')
  await seedSession(id)

  await page.goto(`/#agents/${id}`)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.tap()
  await reply.fill('/btw why this approach?')
  await expect(page.getByRole('button', { name: 'Interrupt and send' })).toBeDisabled()
  await page.getByRole('button', { name: 'Ask aside', exact: true }).tap()

  const sheet = sideChat(page)
  await expect(sheet.getByTestId('side-chat-exchange').first()).toContainText('why this approach?')
  await expect(sheet.locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  await expectFitsPhone(page, 'side chat sheet from /btw')
  await expect(reply).toHaveValue('')
  const sent = JSON.stringify((await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=200`)).messages)
  expect(sent).not.toContain('why this approach')
  expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')

  await sheet.getByRole('button', { name: 'Close side chat' }).tap()
  await expect(sheet).toHaveCount(0)
  await request.post(`/api/tasks/${id}/stop`)
})

test('with the side chat off the phone drops Ask aside, /btw offers Turn on, and on it asks mid-turn', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Phone side off'), prompt: `Please ${HOLD_PROMPT}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok()).toBe(true)
  const { id } = ((await response.json()) as { data: Task }).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')
  await seedSession(id)
  await setModEnabled(request, 'side-chat', false)
  try {
    await page.goto(`/#agents/${id}`)
    await page.getByTestId('agent-header').getByRole('button', { name: 'More actions' }).tap()
    const actions = page.getByRole('dialog', { name: 'Agent actions' })
    await expect(actions.getByRole('button', { name: 'Find in this chat' })).toBeVisible()
    await expect(actions.getByRole('button', { name: 'Ask aside' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(actions).toHaveCount(0)

    const reply = page.getByRole('combobox', { name: 'Reply' })
    await reply.tap()
    await reply.fill('/btw why this approach?')
    const status = page.getByRole('status', { name: 'Composer status' })
    await expect(status).toContainText('Side chat is off')
    await expectFitsPhone(page, 'the side chat off notice')
    await status.getByRole('button', { name: 'Turn on' }).tap()
    await expect(status).toContainText('Asks in the side chat')
    await page.getByRole('button', { name: 'Ask aside', exact: true }).tap()

    const sheet = sideChat(page)
    await expect(sheet.getByTestId('side-chat-exchange').first()).toContainText('why this approach?')
    await expect(sheet.locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
    await expect(reply).toHaveValue('')
    const sent = JSON.stringify((await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=200`)).messages)
    expect(sent).not.toContain('why this approach')
    expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')
  } finally {
    await setModEnabled(request, 'side-chat', true)
    await request.post(`/api/tasks/${id}/stop`)
  }
})
