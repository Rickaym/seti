import type { APIRequestContext, Page } from '@playwright/test'
import { openAgentSettings } from './agent-settings.js'
import { openSeedDb } from './db.js'
import { expect } from './fixtures.js'
import { danaReplies, seedThreadAgent, shot, slackWebhook } from './thread-replies.js'

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
  await shot(page, 'threads')
  const stop = threads.getByRole('button', { name: 'Stop following #deploys' })
  await (tap ? stop.tap() : stop.click())
  await expect(page.getByTestId('task-threads')).toHaveCount(0)
}

/**
 * A new Slack webhook shows both switches off and no hint; turning Threads on brings DMs and says
 * no message event came yet, until one does.
 */
export async function expectRepliesRow(
  page: Page,
  request: APIRequestContext,
  { baseURL, name, tap }: { baseURL: string; name: string; tap: boolean },
): Promise<string> {
  const { channel } = await slackWebhook(request, name)
  await page.goto('/#settings/channels')
  const card = () => page.getByRole('main').getByRole('region', { name })
  const threads = card().getByRole('switch', { name: `${name} thread replies` })
  const dms = card().getByRole('switch', { name: `${name} DM replies` })
  await expect(threads).not.toBeChecked()
  await expect(dms).not.toBeChecked()
  await expect(card().getByTestId('no-message-events')).toHaveCount(0)
  await threads.scrollIntoViewIfNeeded()
  await shot(page, 'webhook-replies-off')
  await (tap ? threads.tap() : threads.click())
  await expect(threads).toBeChecked()
  await expect(dms).toBeChecked()
  await expect(card().getByTestId('no-message-events')).toContainText('No message events yet')
  await shot(page, 'webhook-replies-on')
  await (tap ? dms.tap() : dms.click())
  await expect(dms).not.toBeChecked()
  await danaReplies(baseURL, channel.path, 'C0E2ENOBODY', 'A message nobody follows')
  await page.reload()
  await expect(card().getByRole('switch', { name: `${name} thread replies` })).toBeChecked()
  await expect(card().getByTestId('no-message-events')).toHaveCount(0)
  return channel.id
}
