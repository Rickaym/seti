import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { ChannelInfo, ChannelSecret } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'

async function newChannel(request: APIRequestContext, name: string): Promise<ChannelSecret> {
  const response = await request.post('/api/channels', { data: { name, preset: 'generic', subscribe_ea: false } })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { data: ChannelSecret }).data
}

async function deliver(baseURL: string, created: ChannelSecret, title: string): Promise<void> {
  const body = JSON.stringify({ title, severity: 'info' })
  const signature = `sha256=${createHmac('sha256', created.secret ?? '')
    .update(body)
    .digest('hex')}`
  const sent = await fetch(new URL(created.channel.path, baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-seti-signature': signature },
    body,
  })
  expect(sent.status).toBe(200)
}

test('each channel folds its newest three events and deliveries away until opened', async ({
  page,
  request,
  baseURL,
}) => {
  const tag = randomUUID().slice(0, 8)
  const busy = await newChannel(request, `E2E busy ${tag}`)
  const quiet = await newChannel(request, `E2E quiet ${tag}`)
  try {
    for (let n = 1; n <= 5; n++) {
      await deliver(baseURL ?? '', busy, `alert ${String(n)} ${tag}`)
    }
    const listed = (await apiData<ChannelInfo[]>(request, '/channels')).find((info) => info.id === busy.channel.id)
    expect(listed?.recent).toHaveLength(3)
    expect(listed?.deliveries).toHaveLength(3)

    await page.goto('/#settings/channels')
    const main = page.getByRole('main')
    const card = main.getByRole('region', { name: `E2E busy ${tag}` })
    const other = main.getByRole('region', { name: `E2E quiet ${tag}` })
    const toggle = card.getByRole('button', { name: `E2E busy ${tag} activity` })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toContainText('Last')
    await expect(other.getByRole('button', { name: `E2E quiet ${tag} activity` })).toContainText('Nothing yet')
    await expect(card.getByRole('list', { name: `E2E busy ${tag} events` })).toHaveCount(0)

    await toggle.click()
    const events = card.getByRole('list', { name: `E2E busy ${tag} events` })
    await expect(events.getByRole('listitem')).toHaveCount(3)
    await expect(events.getByRole('listitem').first()).toContainText(`alert 5 ${tag}`)
    await expect(events).not.toContainText(`alert 2 ${tag}`)
    await expect(card.getByRole('list', { name: `E2E busy ${tag} deliveries` }).getByRole('listitem')).toHaveCount(3)
    await expect(other.getByRole('list', { name: `E2E quiet ${tag} events` })).toHaveCount(0)

    await toggle.click()
    await expect(events).toHaveCount(0)
  } finally {
    await request.delete(`/api/channels/${busy.channel.id}`)
    await request.delete(`/api/channels/${quiet.channel.id}`)
  }
})
