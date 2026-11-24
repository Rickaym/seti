import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { ChannelSecret } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'

const SECRET = ['e2e', 'slack', 'signing', 'secret'].join('-')
const ROOT = '1700000000.000100'
const REPLY_TS = '1700000050.000200'
/** Replies wait 10 s and the sweeper runs every 5 s. */
const ROUTED_WITHIN_MS = 40_000

/** An idle agent that holds its updates and once posted the first message of a Slack thread. */
export async function seedThreadAgent(title: string, channel: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, input_mode, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', 'queue', ?, ?)`,
    id,
    title,
    paths.checkout,
    at,
    at,
  )
  await db.run(
    `INSERT INTO thread_follow (task_id, service, space, container, thread, since, url, last_sent_at,
       last_activity_at, created_at) VALUES (?, 'slack', 'acme', ?, ?, ?, NULL, ?, ?, ?)`,
    id,
    channel,
    ROOT,
    ROOT,
    at,
    at,
    at,
  )
  await db.run(
    `INSERT INTO thread_send (service, container, message, task_id, sent_at) VALUES ('slack', ?, ?, ?, ?)`,
    channel,
    ROOT,
    id,
    at,
  )
  await db.close()
  return id
}

/** A Slack webhook with thread replies on; delete it when done. */
export async function slackWebhookWithReplies(request: APIRequestContext, name: string): Promise<ChannelSecret> {
  const created = await request.post('/api/channels', { data: { name, preset: 'slack', secret: SECRET } })
  expect(created.ok()).toBe(true)
  const secret = ((await created.json()) as { data: ChannelSecret }).data
  const on = await request.put(`/api/channels/${secret.channel.id}/threads`, { data: { replies: true } })
  expect(on.ok()).toBe(true)
  return secret
}

/** Dana replies in the thread as the Events API delivers it, signed with the secret. */
export async function danaReplies(baseURL: string, path: string, channel: string, text: string): Promise<void> {
  const body = JSON.stringify({
    type: 'event_callback',
    event_id: `Ev${randomUUID()}`,
    event: {
      type: 'message',
      channel,
      channel_type: 'channel',
      user: 'U0DANA0001',
      user_profile: { display_name: 'Dana' },
      text,
      ts: REPLY_TS,
      thread_ts: ROOT,
    },
  })
  const at = String(Math.floor(Date.now() / 1000))
  const signed = `v0:${at}:${body}`
  const sent = await fetch(new URL(path, baseURL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': at,
      'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(signed).digest('hex')}`,
    },
    body,
  })
  expect(sent.status).toBe(200)
}

/** The reply shows in the transcript as one quiet line: who, where, its words and a link. */
export async function expectThreadReply(page: Page, channel: string): Promise<void> {
  const entry = page.getByRole('main').locator('[data-kind="input"][data-input="thread"]')
  await expect(entry).toBeVisible({ timeout: ROUTED_WITHIN_MS })
  await expect(entry).toContainText(`Dana replied in Slack ${channel}`)
  await expect(entry).toContainText('Could you also check the staging deploy')
  await expect(entry).toContainText('queued')
  const link = entry.getByRole('link', { name: `Open the thread of Dana replied in Slack ${channel}` })
  await expect(link).toHaveAttribute(
    'href',
    `https://acme.slack.com/archives/${channel}/p${REPLY_TS.replace('.', '')}?thread_ts=${ROOT}&cid=${channel}`,
  )
}

/** Saves a screenshot to the folder SETI_E2E_SHOTS names, when it is set. */
export async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env.SETI_E2E_SHOTS
  if (folder !== undefined) {
    await page.screenshot({ path: `${folder}/${name}.png` })
  }
}
