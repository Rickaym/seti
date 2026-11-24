import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { ChannelSecret, Envelope, Task } from '@seti/shared'
import { openSeedDb } from './db.js'
import { EA_HEADERS } from './env.js'
import { SLACK_CHANNEL, SLACK_POSTED, SLACK_PROMPT } from './fake-permission.js'
import { apiData, expect, unique } from './fixtures.js'

const SECRET = ['e2e', 'slack', 'names', 'secret'].join('-')

/** Seti has seen these Slack names before, as an agent's channel search would have shown them. */
export async function seedSlackNames(names: Record<string, string>): Promise<void> {
  const db = openSeedDb()
  for (const [id, name] of Object.entries(names)) {
    await db.run(
      `INSERT INTO slack_name (id, kind, name, source, learned_at) VALUES (?, ?, ?, 'e2e', ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
      id,
      id.startsWith('C') ? 'channel' : 'user',
      name,
      new Date().toISOString(),
    )
  }
  await db.close()
}

/** An agent that asks to post the deploy note to the Slack channel Seti knows as #deploys. */
export async function startSlackPoster(request: APIRequestContext): Promise<string> {
  await seedSlackNames({ [SLACK_CHANNEL]: 'deploys' })
  const response = await request.post('/api/tasks', {
    data: { title: unique('Slack poster'), prompt: `Please ${SLACK_PROMPT}`, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()
  return id
}

/** The request names the channel; once allowed, the transcript row for the send names it too. */
export async function expectNamedRequestAndRow(page: Page, id: string, tap: boolean): Promise<void> {
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const card = main.getByRole('region', { name: /^Permission request for/ })
  await expect(card).toContainText('Send to #deploys: Deploy done')
  await expect(card).not.toContainText(`${SLACK_CHANNEL}, name not known`)
  const allow = card.getByRole('button', { name: 'Allow', exact: true })
  await (tap ? allow.tap() : allow.click())
  await expect(main.getByText(SLACK_POSTED, { exact: true })).toBeVisible()
  await expect(main.getByTestId('tool-summary').filter({ hasText: 'Send to #deploys' })).toHaveText(
    'Send to #deploys: Deploy done',
  )
}

/** A signed Slack app_mention to a new webhook that reports to the EA; the webhook's id. */
export async function mentionReachesEa(request: APIRequestContext, baseURL: string): Promise<string> {
  await seedSlackNames({ U0E2ERICKY: 'Ricky', C0E2EOPS01: 'ops' })
  const created = await request.post('/api/channels', {
    data: { name: unique('Slack mentions'), preset: 'slack', secret: SECRET, subscribe_ea: true },
  })
  expect(created.ok()).toBe(true)
  const { channel } = ((await created.json()) as { data: ChannelSecret }).data
  const body = JSON.stringify({
    type: 'event_callback',
    event_id: `Ev${randomUUID()}`,
    event: { type: 'app_mention', text: '<@U0E2ERICKY> is C0E2EOPS01 on fire?', ts: '1700000001.000100' },
  })
  const at = String(Math.floor(Date.now() / 1000))
  const signed = `v0:${at}:${body}`
  const sent = await fetch(new URL(channel.path, baseURL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': at,
      'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(signed).digest('hex')}`,
    },
    body,
  })
  expect(sent.status).toBe(200)
  const due = await request.get('/api/ea/inbox/due', { headers: EA_HEADERS })
  expect(due.ok()).toBe(true)
  expect(JSON.stringify(await due.json())).toContain('@Ricky is #ops on fire?')
  return channel.id
}
