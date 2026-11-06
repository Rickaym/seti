import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { AuditPage, ChannelSecret, ChannelSubscription, EaInboxItem } from '@seti/shared'
import { EA_HEADERS } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'

const main = (page: Page) => page.getByRole('main')

async function newChannel(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; path: string; secret: string }> {
  const response = await request.post('/api/channels', { data: { name, preset: 'generic' } })
  expect(response.ok()).toBe(true)
  const { channel, secret } = ((await response.json()) as { data: ChannelSecret }).data
  return { id: channel.id, path: channel.path, secret: secret ?? '' }
}

async function deliver(baseURL: string, hook: { path: string; secret: string }, title: string): Promise<void> {
  const body = JSON.stringify({ title, severity: 'critical' })
  const signature = `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}`
  const sent = await fetch(new URL(hook.path, baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-seti-signature': signature },
    body,
  })
  expect(sent.status).toBe(200)
}

async function inboxDue(request: APIRequestContext): Promise<EaInboxItem[]> {
  const response = await request.get('/api/ea/inbox/due', { headers: EA_HEADERS })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { data: EaInboxItem[] }).data
}

/** Hands items to the EA chat and marks them seen, so later specs in this worker start clear. */
async function settleInbox(request: APIRequestContext, ids: readonly number[]): Promise<void> {
  const delivered = await request.post('/api/ea/inbox/deliver', { headers: EA_HEADERS, data: { ids, via: 'chat' } })
  expect(delivered.ok()).toBe(true)
  expect((await request.post('/api/ea/inbox/read', { data: {} })).ok()).toBe(true)
}

test('the EA cog subscribes the EA to a channel, the channel page shows it, and only its events reach the inbox', async ({
  page,
  request,
  baseURL,
}) => {
  const tag = randomUUID().slice(0, 8)
  const followed = await newChannel(request, `E2E followed ${tag}`)
  const ignored = await newChannel(request, `E2E ignored ${tag}`)
  try {
    await page.goto('/#ea')
    await main(page).getByRole('button', { name: 'EA settings' }).click()
    const channels = page.getByTestId('ea-channels')
    await expect(channels).not.toContainText(`E2E followed ${tag}`)
    await channels.getByRole('button', { name: 'Add channel' }).click()
    await page.getByRole('list', { name: 'Channels to subscribe' }).getByText(`E2E followed ${tag}`).click()
    await expect(channels).toContainText(`E2E followed ${tag}`)
    await expect
      .poll(async () => (await apiData<ChannelSubscription[]>(request, '/ea/channels')).map((sub) => sub.channel_id))
      .toContain(followed.id)
    const audit = await apiData<AuditPage>(request, '/audit?kind=system.channel_subscribed')
    expect(audit.events[0]).toMatchObject({
      subject_type: 'ea',
      summary: `Subscribed the EA to the webhook E2E followed ${tag}: every event`,
    })
    await main(page).getByRole('button', { name: 'EA settings' }).click()
    await expect(channels).toBeHidden()

    await deliver(baseURL ?? '', ignored, `ignored alert ${tag}`)
    await deliver(baseURL ?? '', followed, `followed alert ${tag}`)
    const due = await inboxDue(request)
    const titles = due.map((item) => item.title)
    expect(titles).toContain(`followed alert ${tag}`)
    expect(titles).not.toContain(`ignored alert ${tag}`)
    await settleInbox(
      request,
      due.filter((item) => item.title === `followed alert ${tag}`).map((item) => item.id),
    )

    await page.goto('/#settings/channels')
    const card = main(page).getByRole('region', { name: `E2E followed ${tag}` })
    await expect(card.getByRole('switch', { name: `E2E followed ${tag} EA delivery` })).toBeChecked()
    await card.getByRole('button', { name: `E2E followed ${tag} activity` }).click()
    await expect(card.getByTestId('delivery-routes').first()).toContainText('EA: delivered')
    const other = main(page).getByRole('region', { name: `E2E ignored ${tag}` })
    await expect(other.getByRole('switch', { name: `E2E ignored ${tag} EA delivery` })).not.toBeChecked()

    await page.goto('/#ea')
    await main(page).getByRole('button', { name: 'EA settings' }).click()
    await channels.getByRole('button', { name: `Unsubscribe from E2E followed ${tag}` }).click()
    await expect(channels).not.toContainText(`E2E followed ${tag}`)
    expect((await apiData<ChannelSubscription[]>(request, '/ea/channels')).map((sub) => sub.channel_id)).not.toContain(
      followed.id,
    )
  } finally {
    await request.delete(`/api/channels/${followed.id}`)
    await request.delete(`/api/channels/${ignored.id}`)
  }
})

test('the palette opens the EA channels from anywhere', async ({ page }) => {
  await page.goto('/#agents')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill('>EA channels')
  await palette.getByRole('option', { name: /EA channels/ }).click()
  await expect(page).toHaveURL(/#ea$/)
  await expect(page.getByTestId('ea-channels')).toBeVisible()
})
