import type { APIRequestContext, Page } from '@playwright/test'
import type { AuditPage, MessagePage, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { HOLD_PROMPT } from './support/fake-claude.js'
import { SIDE_ANSWER, SIDE_READ, SLOW_QUESTION } from './support/fake-side-chat.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { panelOf, startAgent } from './support/grid.js'
import { setModEnabled } from './support/mods.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { reloadData, seedSession, sideChat } from './support/side-chat.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const rowIds = async (request: APIRequestContext, id: string) =>
  (await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=200`)).messages.map((row) => row.id)

/** Opens the side chat from the command palette, its desktop home besides /btw. */
async function openAsk(page: Page): Promise<void> {
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill('>Ask aside')
  await palette.getByRole('option', { name: /Ask aside/ }).click()
}

async function ask(page: Page, question: string): Promise<void> {
  const field = sideChat(page).getByRole('textbox', { name: 'Side question' })
  await field.fill(question)
  await field.press('Enter')
}

test("Ask answers from the agent's session in a dock, with follow-ups kept, and leaves its chat alone", async ({
  page,
  request,
}) => {
  const title = unique('Side chat')
  const id = await startAgent(request, title)
  const session = await seedSession(id)
  const before = await rowIds(request, id)

  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('button', { name: 'Agent settings' })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'More actions' })).toHaveCount(0)
  await openAsk(page)
  const dock = sideChat(page)
  await expect(dock).toBeVisible()
  await expect(dock.getByRole('textbox', { name: 'Side question' })).toBeFocused()

  await ask(page, 'why did you do that?')
  const first = dock.getByTestId('side-chat-exchange').first()
  await expect(first.locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  await expect(first).toContainText(`about why did you do that?, from session ${session}.`)
  await expect(first).toContainText(`Read ${SIDE_READ}`)
  await expect(first.getByRole('button', { name: 'Send to agent' })).toBeVisible()
  await ask(page, 'and then?')
  await expect(dock.getByTestId('side-chat-exchange')).toHaveCount(2)
  await expect(dock.getByTestId('side-chat-exchange').nth(1)).toContainText('about and then?')

  expect(await rowIds(request, id)).toEqual(before)
  expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  const audit = await apiData<AuditPage>(request, '/audit?kind=task.side_chat&limit=20')
  const started = audit.events.filter((event) => event.subject_id === id)
  expect(started).toHaveLength(1)
  expect(JSON.stringify(started)).not.toContain('why did you do that')

  await dock.getByRole('textbox', { name: 'Side question' }).press('Escape')
  await expect(dock).toHaveCount(0)
  await openAsk(page)
  await expect(sideChat(page).getByTestId('side-chat-exchange')).toHaveCount(2)

  await ask(page, 'what should I tell you?')
  const third = sideChat(page).getByTestId('side-chat-exchange').nth(2)
  await third.getByRole('button', { name: 'Send to agent' }).click()
  await expect(third.getByRole('button', { name: 'Sent' })).toBeDisabled()
  const transcript = page.getByRole('main').getByRole('region', { name: 'Transcript' })
  await expect(transcript.getByText('From a side chat about your work.')).toBeVisible()
})

/** An agent whose fake turn runs until it is stopped, with a session to fork. */
async function busyAgent(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Side busy'), prompt: `Please ${HOLD_PROMPT}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok()).toBe(true)
  const { id } = ((await response.json()) as { data: Task }).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')
  await seedSession(id)
  return id
}

const transcriptText = async (request: APIRequestContext, id: string) =>
  JSON.stringify((await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=200`)).messages)

test('/btw in the composer asks mid-turn in the side chat and sends nothing to the agent', async ({
  page,
  request,
}) => {
  const id = await busyAgent(request)
  await page.goto(`/#agents/${id}`)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('/bt')
  const option = page.getByRole('listbox', { name: 'Command suggestions' }).getByRole('option', { name: /\/btw/ })
  await expect(option).toContainText('Ask a side question; the agent is not interrupted')
  await reply.fill('/btw what are you on?')
  await expect(page.getByRole('status', { name: 'Composer status' })).toContainText('Asks in the side chat')
  await reply.press('Enter')

  const dock = sideChat(page)
  await expect(dock.getByTestId('side-chat-exchange').first()).toContainText('what are you on?')
  await expect(dock.locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  await expect(reply).toHaveValue('')
  expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')
  expect(await transcriptText(request, id)).not.toContain('what are you on')
  await expect(dock.getByRole('button', { name: 'Send to agent' })).toBeVisible()

  await reply.fill('/btw and after that?')
  await reply.press('Enter')
  await expect(dock.getByTestId('side-chat-exchange')).toHaveCount(2)
  await expect(dock.getByTestId('side-chat-exchange').nth(1)).toContainText(SIDE_ANSWER)
  expect(await transcriptText(request, id)).not.toContain('after that')
  expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')
  await page.getByRole('main').getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).not.toBe('running')
})

test('/btw alone opens the side chat empty with its field focused', async ({ page, request }) => {
  const id = await startAgent(request, unique('Side empty'))
  await seedSession(id)
  const before = await rowIds(request, id)
  await page.goto(`/#agents/${id}`)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('/btw')
  await reply.press('Enter')
  await expect(reply).toHaveValue('/btw ')
  await reply.press('Enter')
  const dock = sideChat(page)
  await expect(dock.getByRole('textbox', { name: 'Side question' })).toBeFocused()
  await expect(dock.getByTestId('side-chat-exchange')).toHaveCount(0)
  await expect(reply).toHaveValue('')
  expect(await rowIds(request, id)).toEqual(before)
})

test('a side chat answers mid-turn without stopping the agent, and closing lets the answer finish', async ({
  page,
  request,
}) => {
  const id = await busyAgent(request)

  await page.goto(`/#agents/${id}`)
  await openAsk(page)
  const dock = sideChat(page)
  await ask(page, 'what are you on?')
  await expect(dock.locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')

  await expect(dock.getByRole('button', { name: 'Send to agent' })).toBeVisible()
  await ask(page, SLOW_QUESTION)
  await expect(dock.getByTestId('side-chat-exchange').nth(1)).toContainText(SIDE_ANSWER)
  await ask(page, 'and one more?')
  await expect(dock.getByRole('status', { name: 'Side chat status' })).toContainText('still answering')
  await expect(dock.getByRole('textbox', { name: 'Side question' })).toHaveValue('and one more?')
  await expect(dock.getByTestId('side-chat-exchange')).toHaveCount(2)
  await dock.getByRole('button', { name: 'Close side chat' }).click()
  await expect(dock).toHaveCount(0)
  const asides = page
    .getByRole('main')
    .getByRole('region', { name: 'Transcript' })
    .getByRole('group', { name: 'Aside' })
  await expect(asides.nth(1).getByRole('button', { name: 'Delete aside' })).toBeVisible({ timeout: 15_000 })
  expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')
  await page.getByRole('main').getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).not.toBe('running')
})

test("a grid panel's menu opens the side chat inside the panel", async ({ page, request }) => {
  const title = unique('Side grid')
  const id = await startAgent(request, title)
  await seedSession(id)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  const panel = panelOf(page, title)
  await panel.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Ask aside' }).click()
  const dock = panel.getByRole('dialog', { name: 'Side chat' })
  await expect(dock).toBeVisible()
  const [dockBox, panelBox] = await Promise.all([dock.boundingBox(), panel.boundingBox()])
  expect(dockBox).not.toBeNull()
  expect(panelBox).not.toBeNull()
  if (dockBox !== null && panelBox !== null) {
    expect(dockBox.x).toBeGreaterThanOrEqual(panelBox.x)
    expect(dockBox.x + dockBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
    expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1)
  }
  await ask(page, 'grid question')
  await expect(dock.locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dock).toHaveCount(0)
})

test('turning the side chat off stops its answer, /btw and Ask aside then offer Turn on, and on it asks mid-turn', async ({
  page,
  request,
}) => {
  const id = await busyAgent(request)
  await page.goto(`/#agents/${id}`)
  await openAsk(page)
  await ask(page, SLOW_QUESTION)
  const exchange = sideChat(page).getByTestId('side-chat-exchange').first()
  await expect(exchange).toContainText(SIDE_ANSWER)
  try {
    await setModEnabled(request, 'side-chat', false)
    await expect(exchange).toContainText('ended without an answer')
    await expect(exchange.getByRole('button', { name: 'Send to agent' })).toHaveCount(0)
    await reloadData(page)
    await expect(sideChat(page)).toHaveCount(0)

    const reply = page.getByRole('combobox', { name: 'Reply' })
    const status = page.getByRole('status', { name: 'Composer status' })
    await reply.fill('/btw are you there?')
    await expect(status).toContainText('Side chat is off')
    await reply.press('Enter')
    await expect(reply).toHaveValue('/btw are you there?')
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search Seti' })
    await palette.getByRole('combobox').fill('>Ask aside')
    await expect(palette.getByRole('option', { name: /Ask aside/ })).toContainText('Side chat is off')
    await page.keyboard.press('Escape')
    expect(await transcriptText(request, id)).not.toContain('are you there')

    await status.getByRole('button', { name: 'Turn on' }).click()
    await expect(status).toContainText('Asks in the side chat')
    await reply.press('Enter')
    const dock = sideChat(page)
    await expect(dock.getByTestId('side-chat-exchange').first()).toContainText('are you there?')
    await expect(dock.locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
    await expect(reply).toHaveValue('')
    expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')
    expect(await transcriptText(request, id)).not.toContain('are you there')
  } finally {
    await setModEnabled(request, 'side-chat', true)
    await request.post(`/api/tasks/${id}/stop`)
  }
})

test("a grid panel's menu drops Ask aside while the side chat is off", async ({ page, request }) => {
  const title = unique('Side grid off')
  const id = await startAgent(request, title)
  await seedSession(id)
  const asidesLoaded = page.waitForResponse((r) => r.url().endsWith(`/side-chat/tasks/${id}/asides`) && r.ok())
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  const panel = panelOf(page, title)
  await asidesLoaded
  try {
    await setModEnabled(request, 'side-chat', false)
    await reloadData(page)
    await panel.getByRole('button', { name: 'More actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'Find in this chat' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Ask aside' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await setModEnabled(request, 'side-chat', true)
    await reloadData(page)
    await panel.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Ask aside' }).click()
    await expect(panel.getByRole('dialog', { name: 'Side chat' })).toBeVisible()
  } finally {
    await setModEnabled(request, 'side-chat', true)
  }
})
