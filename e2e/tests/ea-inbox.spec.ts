import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type {
  AuditPage,
  EaFollowup,
  EaHealth,
  EaInboxDelivered,
  EaInboxItem,
  EaInboxUnread,
  EaLlmMessage,
  EaWatch,
} from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { EA_HEADERS, paths } from './support/env.js'
import { fakeEaChat, type FakeChat } from './support/fake-ea.js'
import { apiData, expect, test } from './support/fixtures.js'

const READY: EaHealth = {
  ok: true,
  configured: true,
  missing: [],
  model: 'gpt-4.1-mini',
  text_model: 'gpt-4.1',
  chat_missing: [],
  turn: true,
}
const BOT = EA_HEADERS

const main = (page: Page) => page.getByRole('main')
const transcript = (page: Page) => main(page).getByRole('region', { name: 'Transcript' })
const composer = (page: Page) => page.getByRole('combobox', { name: 'Message the EA' })

async function asBot<T>(request: APIRequestContext, method: 'GET' | 'POST', url: string, data?: unknown) {
  const response =
    method === 'GET' ? await request.get(url, { headers: BOT }) : await request.post(url, { headers: BOT, data })
  expect(response.ok(), `${method} ${url}`).toBe(true)
  return ((await response.json()) as { data: T }).data
}

async function storeReply(request: APIRequestContext, entries: { kind: 'chat'; message: EaLlmMessage }[]) {
  return (await asBot<{ ids: number[] }>(request, 'POST', '/api/ea/history/messages', { entries })).ids
}

let chat: FakeChat | null = null

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/ea/history')).ok()).toBe(true)
  for (const item of await apiData<EaFollowup[]>(request, '/ea/followups')) {
    await request.delete(`/api/ea/followups/${String(item.id)}`)
  }
})

test.afterEach(async ({ request }) => {
  await chat?.close()
  chat = null
  await request.post('/api/ea/inbox/read', { data: {} })
})

test('an inbox item shows in the EA chat with an unread count that opening the chat clears', async ({
  page,
  request,
}) => {
  const reminder = await asBot<EaFollowup>(request, 'POST', '/api/ea/followups', {
    kind: 'reminder',
    when: 'in 1 second',
    note: 'Review the release notes',
    timezone: 'Europe/Berlin',
  })
  await expect
    .poll(async () => (await asBot<EaInboxItem[]>(request, 'GET', '/api/ea/inbox/due')).map((item) => item.id))
    .toContain(reminder.id)
  await asBot<EaInboxDelivered>(request, 'POST', '/api/ea/inbox/deliver', { ids: [reminder.id], via: 'chat' })
  await storeReply(request, [
    { kind: 'chat', message: { role: 'assistant', content: 'A reminder: review the release notes.' } },
  ])
  expect(await apiData<EaInboxUnread>(request, '/ea/inbox/unread')).toMatchObject({ unread: 1 })

  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.goto('/#agents')
  const badge = page.getByTestId('ea-unread')
  await expect(badge).toHaveText('1')
  await expect(badge).toHaveAccessibleName('1 new in the EA chat')
  await badge.click()
  await expect(page).toHaveURL(/#ea$/)
  const notice = transcript(page).locator('[data-kind="notice"]')
  await expect(notice).toHaveAttribute('data-notice', 'reminder')
  await expect(notice).toContainText('Review the release notes')
  await expect(transcript(page)).toContainText('A reminder: review the release notes.')
  await expect(badge).toHaveCount(0)
  await expect.poll(async () => apiData<EaInboxUnread>(request, '/ea/inbox/unread')).toMatchObject({ unread: 0 })
})

test('the EA schedules a follow-up and watches a task from the chat; the user cancels both', async ({
  page,
  request,
}) => {
  const db = openSeedDb()
  const taskId = randomUUID()
  await db.idleTask(taskId, 'Voicemail greeting', paths.root, new Date().toISOString())
  await db.close()

  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  chat = await fakeEaChat(page)
  await page.goto('/#ea')
  await composer(page).fill('Watch the voicemail task and check back on it in 20 minutes.')
  await composer(page).press('Enter')
  const asked = await chat.next()

  const followup = await asBot<EaFollowup>(request, 'POST', '/api/ea/followups', {
    when: 'in 20 minutes',
    note: 'Check whether the voicemail greeting is done',
    timezone: asked.timezone,
    task_id: taskId,
  })
  expect(followup.local_due).toMatch(/\(Europe\/Berlin\)$/)
  await asBot<EaWatch>(request, 'POST', '/api/ea/watches', { task_id: taskId, note: 'the user asked' })
  asked.send({ type: 'tool', id: 'c1', name: 'schedule_followup', arguments: { when: 'in 20 minutes' } })
  asked.send({
    type: 'tool_result',
    id: 'c1',
    name: 'schedule_followup',
    summary: 'Follow-up scheduled',
    ok: true,
    text: `Scheduled a follow-up for ${followup.local_due}.`,
  })
  asked.send({ type: 'text', delta: 'Watching it; I will check back in twenty minutes.' })
  const ids = await storeReply(request, [
    {
      kind: 'chat',
      message: { role: 'user', content: 'Watch the voicemail task and check back on it in 20 minutes.' },
    },
    { kind: 'chat', message: { role: 'assistant', content: 'Watching it; I will check back in twenty minutes.' } },
  ])
  asked.send({ type: 'done', ids })
  asked.end()
  await expect(page.getByRole('button', { name: 'Stop the reply' })).toHaveCount(0)

  const watch = page.getByRole('button', { name: 'Scheduled and watched' })
  await expect(watch).toContainText('Watch')
  expect((await watch.locator('svg').boundingBox())?.width).toBe(16)
  await watch.click()
  const scheduled = page.getByRole('list', { name: 'Scheduled' })
  await expect(scheduled).toContainText('Check whether the voicemail greeting is done')
  await expect(scheduled).toContainText(followup.local_due)
  await expect(page.getByRole('list', { name: 'Watching' })).toContainText('Voicemail greeting')

  await page.getByRole('button', { name: 'Cancel Check whether the voicemail greeting is done' }).click()
  await expect(page.getByText('No follow-ups or reminders.')).toBeVisible()
  await page.getByRole('button', { name: 'Stop watching Voicemail greeting' }).click()
  await expect(page.getByText('No agents.')).toBeVisible()

  await expect.poll(async () => apiData<EaFollowup[]>(request, '/ea/followups')).toEqual([])
  await expect.poll(async () => apiData<EaWatch[]>(request, '/ea/watches')).toEqual([])
  const kinds = async () =>
    (await apiData<AuditPage>(request, '/audit?kind=ea&limit=20')).events.map((event) => [
      event.kind,
      event.detail.via ?? null,
    ])
  await expect.poll(kinds).toEqual(
    expect.arrayContaining([
      ['ea.followup_scheduled', 'ea'],
      ['ea.watch_added', 'ea'],
      ['ea.followup_cancelled', null],
      ['ea.watch_removed', null],
    ]),
  )
})

test('a webhook made on the channels page takes signed deliveries to the page and the EA chat', async ({
  page,
  request,
  baseURL,
}) => {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.goto('/#settings/channels')
  await main(page).getByRole('button', { name: 'New', exact: true }).click()
  await page
    .getByRole('list', { name: 'Channel sources' })
    .getByRole('button', { name: /Webhook/ })
    .click()
  const form = page.getByRole('dialog', { name: 'New webhook' })
  await form.getByRole('textbox', { name: 'Name' }).fill('E2E monitor')
  const eaDelivery = form.getByRole('switch', { name: 'EA delivery' })
  await expect(eaDelivery).not.toBeChecked()
  await eaDelivery.click()
  await form.getByRole('button', { name: 'Create' }).click()
  const shown = page.getByRole('dialog', { name: 'E2E monitor' })
  const secret = (await shown.getByTestId('webhook-secret').textContent()) ?? ''
  const hookPath = new URL((await shown.getByTestId('webhook-url').textContent()) ?? '').pathname
  expect(secret).toMatch(/^whsec_/)
  expect(hookPath).toMatch(/^\/hooks\/[\w-]{24}$/)
  await shown.getByRole('button', { name: 'Done' }).click()
  const card = main(page).getByRole('region', { name: 'E2E monitor' })
  const channelId = hookPath.split('/').at(-1) ?? ''
  try {
    await expect(card.getByTestId('channel-url')).toContainText(hookPath)
    await expect(main(page)).not.toContainText(secret)

    const body = JSON.stringify({ title: 'checkout is down', service: 'checkout', status: 'down', message: 'HTTP 503' })
    const json = { 'content-type': 'application/json' }
    const deliver = async (headers: Record<string, string>) =>
      fetch(new URL(hookPath, baseURL), { method: 'POST', headers: { ...json, ...headers }, body })
    expect((await deliver({})).status).toBe(401)
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const sent = await deliver({ 'x-seti-signature': signature })
    expect(sent.status).toBe(200)
    expect(await sent.json()).toEqual({ data: { status: 'accepted', reason: 'sent to the EA inbox' }, meta: {} })

    await page.reload()
    await card.getByRole('button', { name: 'E2E monitor activity' }).click()
    await expect(card.getByRole('list', { name: 'E2E monitor events' })).toContainText('checkout is down')
    const deliveries = card.getByRole('list', { name: 'E2E monitor deliveries' })
    await expect(deliveries).toContainText('sent to the EA inbox')
    await expect(deliveries).toContainText('missing signature')
    await card.getByRole('button', { name: 'Test' }).click()
    await expect(card.getByRole('list', { name: 'E2E monitor events' })).toContainText('Test event from Seti')

    const due = await asBot<EaInboxItem[]>(request, 'GET', '/api/ea/inbox/due')
    const item = due.find((entry) => entry.title === 'checkout is down')
    expect(item).toMatchObject({ kind: 'channel_event', event: 'down', severity: 'critical', source: 'E2E monitor' })
    await asBot<EaInboxDelivered>(request, 'POST', '/api/ea/inbox/deliver', { ids: [item?.id], via: 'chat' })
    await page.goto('/#ea')
    const notice = transcript(page).locator('[data-kind="notice"]')
    await expect(notice).toHaveAttribute('data-notice', 'channel_event')
    await expect(notice).toContainText('checkout is down')
  } finally {
    await request.delete(`/api/channels/${channelId}`)
  }
})
