import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { ChannelSecret, Envelope, Task } from '@seti/shared'
import { openSeedDb } from './db.js'
import { EA_HEADERS } from './env.js'
import {
  SLACK_CHANNEL,
  SLACK_LOOKUP_PROMPT,
  SLACK_POSTED,
  SLACK_PROMPT,
  SLACK_UNNAMED_CHANNEL,
} from './fake-permission.js'
import { apiData, expect, unique } from './fixtures.js'
import { shot } from './thread-replies.js'

const SECRET = ['e2e', 'slack', 'names', 'secret'].join('-')

/** Seti has seen these Slack names before, as an agent's channel search would have shown them. */
async function seedSlackNames(names: Record<string, string>): Promise<void> {
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

async function startAgent(request: APIRequestContext, title: string, prompt: string): Promise<string> {
  const response = await request.post('/api/tasks', { data: { title: unique(title), prompt, sandbox: false } })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  return ((await response.json()) as Envelope<Task>).data.id
}

/** An agent that asks to post the deploy note to #deploys, or to a channel Seti never saw named. */
export async function startSlackPoster(
  request: APIRequestContext,
  named: boolean,
  channel = SLACK_UNNAMED_CHANNEL,
): Promise<string> {
  await seedSlackNames({ [SLACK_CHANNEL]: 'deploys' })
  const where = named ? '' : `, in ${channel}`
  const id = await startAgent(request, 'Slack poster', `Please ${SLACK_PROMPT}${where}`)
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
  await expect(card.getByRole('button', { name: 'Look up' })).toHaveCount(named ? 0 : 1)
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

/** A Slack channel id no other test uses, so Seti has never seen it named. */
const freshChannel = () =>
  `C0LK${randomUUID()
    .replace(/[^0-9a-f]/g, '')
    .slice(0, 8)
    .toUpperCase()}`

/**
 * While a send to an unnamed channel waits, another agent's channel search states the name: the
 * request and the transcript row show it without a reload, and Look up goes away.
 */
export async function expectNameArrivesLive(page: Page, request: APIRequestContext, tap: boolean): Promise<void> {
  const channel = freshChannel()
  const poster = await startSlackPoster(request, false, channel)
  await page.goto(`/#agents/${poster}`)
  const main = page.getByRole('main')
  const card = main.getByRole('region', { name: /^Permission request for/ })
  const unnamed = `Send to channel ${channel}, name not known: Deploy done`
  await expect(card).toContainText(unnamed)
  await expect(main.getByTestId('tool-summary').filter({ hasText: channel })).toHaveText(unnamed)
  await expect(card.getByRole('button', { name: 'Look up' })).toBeVisible()
  await startAgent(request, 'Slack lookup', `Please ${SLACK_LOOKUP_PROMPT} ${channel} as #releases`)
  await expect(card).toContainText('Send to #releases: Deploy done')
  await expect(main.getByTestId('tool-summary').filter({ hasText: '#releases' })).toHaveText(
    'Send to #releases: Deploy done',
  )
  await expect(card.getByRole('button', { name: 'Look up' })).toHaveCount(0)
  await card.scrollIntoViewIfNeeded()
  await shot(page, 'slack-name-live')
  const allow = card.getByRole('button', { name: 'Allow', exact: true })
  await (tap ? allow.tap() : allow.click())
  await expect(main.getByText(SLACK_POSTED, { exact: true })).toBeVisible()
}

/**
 * With the call's fields open, the channel field names its id, follows an edit to another id,
 * says when a value is not an id, and the message field lists who it mentions by name.
 */
export async function expectFieldNames(page: Page, request: APIRequestContext): Promise<void> {
  await seedSlackNames({ U0E2EDANA01: 'Dana' })
  const channel = freshChannel()
  const poster = await startSlackPoster(request, false, `${channel} cc U0E2EDANA01`)
  await page.goto(`/#agents/${poster}`)
  const card = page.getByRole('main').getByRole('region', { name: /^Permission request for/ })
  await expect(card).toContainText(`Send to channel ${channel}, name not known: Deploy done, cc @Dana`)
  await card.getByRole('button', { name: 'Edit' }).click()
  const fields = card.getByRole('group', { name: 'Call fields' })
  const id = fields.getByRole('textbox', { name: 'channel_id' })
  const notes = fields.getByTestId('slack-field-note')
  await expect(notes).toHaveText(['Name not known', 'Mentions Dana'])
  await expect(card.getByRole('button', { name: 'Look up' })).toBeVisible()
  await card.scrollIntoViewIfNeeded()
  await shot(page, 'slack-fields-unnamed')
  await id.fill(SLACK_CHANNEL)
  await expect(notes.first()).toHaveText('#deploys')
  await shot(page, 'slack-fields-named')
  await id.fill('U0E2EDANA01')
  await expect(notes.first()).toHaveText('DM to Dana')
  await shot(page, 'slack-fields-dm')
  await id.fill('deploys')
  await expect(notes.first()).toHaveText('Not a Slack id')
  await card.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(card).toHaveCount(0)
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
