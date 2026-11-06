import { randomUUID } from 'node:crypto'
import type { ChannelSecret, ChannelSubscription } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { edgesAtRest, expectFitsPhone } from './support/phone-layout.js'

test('the EA cog fits a phone and adds and removes a channel', async ({ page, request }) => {
  const name = `Phone alerts ${randomUUID().slice(0, 6)}`
  const response = await request.post('/api/channels', { data: { name, preset: 'generic' } })
  expect(response.ok()).toBe(true)
  const { channel } = ((await response.json()) as { data: ChannelSecret }).data
  try {
    await page.goto('/#ea')
    await page.getByRole('main').getByRole('button', { name: 'EA settings' }).tap()
    const sheet = page.getByRole('dialog', { name: 'EA settings' })
    const channels = sheet.getByTestId('ea-channels')
    await expect(channels).toBeVisible()
    const edges = await edgesAtRest(page, sheet)
    expect(edges.top).toBeGreaterThan(0)
    expect(edges.bottom).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1)
    await expectFitsPhone(page, 'EA settings')
    await channels.getByRole('button', { name: 'Add channel' }).tap()
    await page.getByRole('list', { name: 'Channels to subscribe' }).getByText(name).tap()
    await expect(channels).toContainText(name)
    await expectFitsPhone(page, 'EA settings with a channel')
    expect((await apiData<ChannelSubscription[]>(request, '/ea/channels')).map((sub) => sub.channel_id)).toContain(
      channel.id,
    )
    await channels.getByRole('button', { name: `Unsubscribe from ${name}` }).tap()
    await expect(channels).not.toContainText(name)
    await sheet.getByRole('button', { name: 'Close EA settings' }).tap()
    await expect(sheet).toBeHidden()
  } finally {
    await request.delete(`/api/channels/${channel.id}`)
  }
})

test('the EA act toggle on a channel card fits a phone', async ({ page, request }) => {
  const name = `Phone asks ${randomUUID().slice(0, 6)}`
  const response = await request.post('/api/channels', { data: { name, preset: 'generic', subscribe_ea: true } })
  expect(response.ok()).toBe(true)
  const { channel } = ((await response.json()) as { data: ChannelSecret }).data
  try {
    await page.goto('/#settings/channels')
    const card = page.getByRole('main').getByRole('region', { name })
    const act = card.getByRole('button', { name: 'Auto act', exact: true })
    await act.tap()
    await expect(act).toHaveAttribute('aria-pressed', 'true')
    await expectFitsPhone(page, 'channel card with the EA acting')
    await card.getByRole('button', { name: `${name} activity` }).tap()
    await expect(card.getByRole('list', { name: `${name} events` })).toHaveCount(0)
    await expect(card.getByText('Nothing yet.').first()).toBeVisible()
    await expectFitsPhone(page, 'channel card with its activity open')
    await expect
      .poll(
        async () =>
          (await apiData<ChannelSubscription[]>(request, '/ea/channels')).find((sub) => sub.channel_id === channel.id)
            ?.mode,
      )
      .toBe('act')
  } finally {
    await request.delete(`/api/channels/${channel.id}`)
  }
})
