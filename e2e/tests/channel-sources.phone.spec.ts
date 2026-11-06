import { randomUUID } from 'node:crypto'
import type { ChannelSecret } from '@seti/shared'
import { cleanUpWebhook, SENTRY_SECRET, sentryToggle } from './support/channel-sources.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const name = `Phone Sentry ${randomUUID().slice(0, 6)}`

test.afterEach(async ({ request }) => {
  await cleanUpWebhook(request, name)
})

test('the phone shows a Sentry webhook paused while its mod is off, and turns the mod back on', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/channels', { data: { name, preset: 'sentry', secret: SENTRY_SECRET } })
  expect(response.ok()).toBe(true)
  expect(((await response.json()) as { data: ChannelSecret }).data.channel.preset).toBe('sentry-webhooks.sentry')

  await page.goto('/#settings/mods')
  await sentryToggle(page).scrollIntoViewIfNeeded()
  await sentryToggle(page).tap()
  await expect(sentryToggle(page)).toHaveAttribute('aria-pressed', 'false')

  await page.goto('/#settings/channels')
  const card = page.getByRole('main').getByRole('region', { name })
  await expect(card).toContainText('The Sentry webhooks mod is off, so this webhook refuses every delivery.')
  await expect(card.getByRole('button', { name: 'Test' })).toBeDisabled()
  await expectFitsPhone(page, 'a webhook paused by its mod')

  await card.getByRole('link', { name: 'Mods' }).tap()
  await sentryToggle(page).scrollIntoViewIfNeeded()
  await sentryToggle(page).tap()
  await expect(sentryToggle(page)).toHaveAttribute('aria-pressed', 'true')
  await page.goto('/#settings/channels')
  await expect(card).toContainText('Sentry: signed with Sentry-Hook-Signature')
  await expect(card).not.toContainText('Paused')
})
