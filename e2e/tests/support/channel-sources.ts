import type { APIRequestContext, Page } from '@playwright/test'
import type { ChannelInfo } from '@seti/shared'
import { apiData } from './fixtures.js'

const SENTRY_MOD = 'Sentry webhooks'

/** A client secret as Sentry issues one, which Seti takes when the channel is made. */
export const SENTRY_SECRET = ['sentry', 'client', 'secret', 'for', 'e2e'].join('-')

/** Turns the Sentry webhooks mod back on and deletes the channel, so the next test starts clean. */
export async function cleanUpWebhook(request: APIRequestContext, name: string): Promise<void> {
  await request.patch('/api/mods/sentry-webhooks', { data: { enabled: true } })
  const made = (await apiData<ChannelInfo[]>(request, '/channels')).find((info) => info.name === name)
  if (made !== undefined) {
    await request.delete(`/api/channels/${made.id}`)
  }
}

/** The Sentry webhooks mod's switch on Settings, Mods. */
export const sentryToggle = (page: Page) =>
  page.getByRole('region', { name: 'Mods' }).getByRole('button', { name: SENTRY_MOD, exact: true })
