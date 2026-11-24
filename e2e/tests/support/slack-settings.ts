import type { APIRequestContext, Page } from '@playwright/test'
import { openAgentSettings } from './agent-settings.js'
import { openSeedDb } from './db.js'
import { expect } from './fixtures.js'
import { danaReplies, seedThreadAgent, shot, slackWebhookWithReplies } from './thread-replies.js'

/** An agent following one Slack thread in a channel Seti knows by name. */
export async function seedFollower(title: string, channel: string): Promise<string> {
  const id = await seedThreadAgent(title, channel)
  const db = openSeedDb()
  await db.run(
    `INSERT INTO slack_name (id, kind, name, source, learned_at) VALUES (?, 'channel', 'deploys', 'e2e', ?)
     ON CONFLICT (id) DO NOTHING`,
    channel,
    new Date().toISOString(),
  )
  await db.close()
  return id
}

/** The agent's Team tab lists the thread by name; Stop removes it. */
export async function stopFollowedThread(page: Page, id: string, tap: boolean): Promise<void> {
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Team')
  const threads = page.getByTestId('task-threads')
  await expect(threads).toContainText('#deploys')
  await expect(threads).toContainText('0 replies')
  await shot(page, tap ? 'threads-phone' : 'threads-desktop')
  const stop = threads.getByRole('button', { name: 'Stop following #deploys' })
  await (tap ? stop.tap() : stop.click())
  await expect(page.getByTestId('task-threads')).toHaveCount(0)
}

/** The Slack webhook shows its switches and says when no message event came yet, until one does. */
export async function expectMessageEventsLine(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
  name: string,
): Promise<string> {
  const { channel } = await slackWebhookWithReplies(request, name)
  await page.goto('/#settings/channels')
  const card = page.getByRole('main').getByRole('region', { name })
  await expect(card.getByRole('switch', { name: `${name} thread replies` })).toBeChecked()
  await expect(card.getByRole('switch', { name: `${name} DM replies` })).toBeChecked()
  await expect(card.getByTestId('no-message-events')).toContainText('No message events yet')
  await card.getByRole('switch', { name: `${name} DM replies` }).click()
  await expect(card.getByRole('switch', { name: `${name} DM replies` })).not.toBeChecked()
  await danaReplies(baseURL, channel.path, 'C0E2ENOBODY', 'A message nobody follows')
  await page.reload()
  await expect(page.getByRole('main').getByRole('region', { name }).getByTestId('no-message-events')).toHaveCount(0)
  return channel.id
}
