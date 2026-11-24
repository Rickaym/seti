import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { ChannelSecret, Envelope, Task } from '@seti/shared'
import { openSeedDb } from './db.js'
import { EA_HEADERS } from './env.js'
import { SLACK_CHANNEL, SLACK_POSTED, SLACK_PROMPT, SLACK_UNNAMED_CHANNEL } from './fake-permission.js'
import { apiData, expect, unique } from './fixtures.js'
import { shot } from './thread-replies.js'

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

/** An agent that asks to post the deploy note to #deploys, or to a channel Seti never saw named. */
export async function startSlackPoster(request: APIRequestContext, named: boolean): Promise<string> {
  await seedSlackNames({ [SLACK_CHANNEL]: 'deploys' })
  const prompt = named ? `Please ${SLACK_PROMPT}` : `Please ${SLACK_PROMPT}, in ${SLACK_UNNAMED_CHANNEL}`
  const response = await request.post('/api/tasks', {
    data: { title: unique('Slack poster'), prompt, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()
  return id
}

/** How the request and the transcript row read the destination. */
const shown = (named: boolean) =>
  named ? 'Send to #deploys' : `Send to channel ${SLACK_UNNAMED_CHANNEL}, name not known`

/** The request names the channel or says it is not known; once allowed, the row says the same. */
export async function expectSendRequestAndRow(page: Page, id: string, tap: boolean, named: boolean): Promise<void> {
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const card = main.getByRole('region', { name: /^Permission request for/ })
  await expect(card).toContainText(`${shown(named)}: Deploy done`)
  await card.scrollIntoViewIfNeeded()
  await shot(page, `slack-request-${named ? 'named' : 'unnamed'}`)
  const allow = card.getByRole('button', { name: 'Allow', exact: true })
  await (tap ? allow.tap() : allow.click())
  await expect(main.getByText(SLACK_POSTED, { exact: true })).toBeVisible()
  await expect(main.getByTestId('tool-summary').filter({ hasText: shown(named) })).toHaveText(
    `${shown(named)}: Deploy done`,
  )
  await shot(page, `slack-send-row-${named ? 'named' : 'unnamed'}`)
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
