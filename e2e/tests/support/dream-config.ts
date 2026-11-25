import type { APIRequestContext, Page } from '@playwright/test'
import type { ChannelSecret, ChannelSubscription, Envelope } from '@seti/shared'
import { openSeedDb } from './db.js'
import { dreams } from './dreams.js'
import { apiData, expect, unique } from './fixtures.js'

const DAY_MS = 24 * 60 * 60_000

/** A webhook the agent subscribed to 60 days ago that has delivered nothing since. */
export async function unusedSubscription(request: APIRequestContext, agent: string) {
  const name = unique('ci-alerts')
  const made = await request.post('/api/channels', { data: { name, preset: 'generic', subscribe_ea: false } })
  expect(made.ok(), 'POST /api/channels').toBe(true)
  const channel = ((await made.json()) as Envelope<ChannelSecret>).data.channel.id
  const sub = await request.post(`/api/channels/${channel}/subscriptions`, { data: { target: 'task', task_id: agent } })
  expect(sub.ok(), 'POST subscriptions').toBe(true)
  const db = openSeedDb()
  await db.run(
    'UPDATE channel_subscription SET created_at = ? WHERE channel_id = ?',
    new Date(Date.now() - 60 * DAY_MS).toISOString(),
    channel,
  )
  await db.close()
  return { name, channel }
}

/** The agent's subscriptions to a channel, as the channel's page reads them. */
export const subscribers = async (request: APIRequestContext, channel: string) =>
  (await apiData<ChannelSubscription[]>(request, `/channels/${channel}/subscriptions`)).map((sub) => sub.task_id)

/** The list of configuration a dream changed, inside the last dream's report. */
export const configChanges = (page: Page) => dreams(page).getByRole('list', { name: 'Configuration changes' })
