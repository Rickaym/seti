import { createHmac } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { ChannelInfo, ChannelSecret, ChannelSubscribeInput, Envelope } from '@seti/shared'
import { AGENTS, at } from './seed.js'
import type { ServiceName, Sources } from './sources.js'
import { openSeedDb } from '../tests/support/db.js'
import { EA_HEADERS } from '../tests/support/env.js'

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`/api${path}`, { data })
  if (!response.ok()) {
    throw new Error(`POST /api${path}: ${await response.text()}`)
  }
  return ((await response.json()) as Envelope<T>).data
}

const subscribe = async (request: APIRequestContext, id: string, input: ChannelSubscribeInput) =>
  post(request, `/channels/${id}/subscriptions`, input)

const ea = (events: string[] | null, mode: 'report' | 'act' = 'report'): ChannelSubscribeInput => ({
  target: 'ea',
  events,
  mode,
})

const agent = (taskId: string, events: string[] | null): ChannelSubscribeInput => ({
  target: 'task',
  task_id: taskId,
  events,
})

const signed = (secret: string, body: string, prefix = 'sha256=') =>
  `${prefix}${createHmac('sha256', secret).update(body).digest('hex')}`

const REPO = { full_name: 'acme/storefront', html_url: 'https://github.com/acme/storefront' }

const run = (conclusion: string) => ({
  action: 'completed',
  repository: REPO,
  workflow_run: {
    name: 'CI',
    head_branch: 'fix/checkout-capture-retry',
    conclusion,
    html_url: 'https://github.com/acme/storefront/actions/runs/9021',
  },
})

const GITHUB_EVENTS: [event: string, payload: unknown][] = [
  [
    'pull_request',
    {
      action: 'opened',
      repository: REPO,
      sender: { login: 'seti-agent' },
      pull_request: {
        number: 482,
        title: 'fix(checkout): retry card captures on gateway timeouts',
        html_url: 'https://github.com/acme/storefront/pull/482',
      },
    },
  ],
  ['workflow_run', run('failure')],
  ['workflow_run', run('success')],
]

/** GitHub posts signed events for the storefront; the EA and the checkout agent follow its CI. */
async function seedGithub(request: APIRequestContext, baseURL: string): Promise<void> {
  const { channel, secret } = await post<ChannelSecret>(request, '/channels', {
    name: 'GitHub acme/storefront',
    preset: 'github',
  })
  await subscribe(request, channel.id, ea(['workflow_run', 'pull_request.closed']))
  await subscribe(request, channel.id, agent(AGENTS.checkout, ['workflow_run']))
  for (const [n, [event, payload]] of GITHUB_EVENTS.entries()) {
    const body = JSON.stringify(payload)
    await fetch(new URL(channel.path, baseURL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': `7f3c9a10-0000-4000-8000-00000000000${String(n)}`,
        'x-hub-signature-256': signed(secret ?? '', body),
      },
      body,
    })
  }
}

/** A generic webhook from the deploy pipeline, signed with the secret Seti issued. */
async function seedDeploys(request: APIRequestContext, baseURL: string): Promise<void> {
  const { channel, secret } = await post<ChannelSecret>(request, '/channels', {
    name: 'Storefront deploys',
    preset: 'generic',
  })
  await subscribe(request, channel.id, ea(null))
  for (const [title, severity] of [
    ['Deploy 2026.10.27-2 rolled back: health check failed', 'critical'],
    ['Deploy 2026.10.27-3 reached production', 'info'],
  ]) {
    const body = JSON.stringify({ title, severity })
    await fetch(new URL(channel.path, baseURL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-seti-signature': signed(secret ?? '', body) },
      body,
    })
  }
}

interface PollerSeed {
  name: string
  service: ServiceName
  preset: 'http_json' | 'feed'
  script: (origin: string) => string
  interval_s: number
  fingerprint_fields?: string[]
  secrets?: string[]
  detect_gone?: boolean
  subscribers: ChannelSubscribeInput[]
}

const STATUS_SCRIPT = (origin: string) => `export default async function poll({ fetch }) {
  const res = await fetch('${origin}/api/v2/components.json')
  const { components } = await res.json()
  return components.map((c) => ({
    key: c.id,
    kind: 'component',
    title: \`\${c.name}: \${c.status.replaceAll('_', ' ')}\`,
    fields: { status: c.status },
  }))
}
`

const FEED_SCRIPT = (origin: string) => `export default async function poll({ fetch, parseFeed }) {
  const res = await fetch('${origin}/en/feed/releases.xml')
  return parseFeed(await res.text()).map((entry) => ({
    key: entry.id,
    kind: 'release',
    title: entry.title,
    url: entry.link,
    summary: entry.summary,
  }))
}
`

const TICKETS_SCRIPT = (origin: string) => `export default async function poll({ fetch }) {
  const res = await fetch('${origin}/v1/tickets?status=open', {
    secretHeaders: { Authorization: 'Bearer {{helpdesk_token}}' },
  })
  const { tickets } = await res.json()
  return tickets.map((t) => ({
    key: String(t.id),
    kind: 'ticket',
    title: \`#\${t.id} \${t.subject}\`,
    fields: { priority: t.priority, status: t.status },
  }))
}
`

const POLLERS: PollerSeed[] = [
  {
    name: 'Payments provider status',
    service: 'payments',
    preset: 'http_json',
    script: STATUS_SCRIPT,
    interval_s: 300,
    fingerprint_fields: ['status'],
    subscribers: [ea(['component'], 'act'), agent(AGENTS.checkout, ['component.changed'])],
  },
  {
    name: 'Support tickets',
    service: 'helpdesk',
    preset: 'http_json',
    script: TICKETS_SCRIPT,
    interval_s: 600,
    fingerprint_fields: ['priority', 'status'],
    secrets: ['helpdesk_token'],
    detect_gone: true,
    subscribers: [ea(['ticket'])],
  },
  {
    name: 'Node.js releases',
    service: 'node',
    preset: 'feed',
    script: FEED_SCRIPT,
    interval_s: 6 * 3600,
    subscribers: [ea(['release'])],
  },
]

/** Pollers for services that send no webhooks: run once to record, then once after a change. */
async function seedPollers(request: APIRequestContext, sources: Sources): Promise<void> {
  const ids: string[] = []
  for (const seed of POLLERS) {
    const { subscribers, service, script, ...settings } = seed
    const origin = sources.origin(service)
    const created = await post<ChannelInfo>(request, '/channels/pollers', {
      ...settings,
      script: script(origin),
      extra_hosts: [new URL(origin).host],
      enabled: false,
    })
    for (const subscriber of subscribers) {
      await subscribe(request, created.id, subscriber)
    }
    ids.push(created.id)
  }
  for (const stage of [0, 1]) {
    if (stage === 1) {
      sources.advance()
    }
    for (const id of ids) {
      await post(request, `/channels/pollers/${id}/poll`, {})
    }
  }
}

const REMINDER = `export default function remind({ state }) {
  return 'Friday release check: merge what is green, close stale PRs, and post the changelog.'
}
`

async function seedReminder(request: APIRequestContext): Promise<void> {
  const created = await post<ChannelInfo>(request, '/channels/reminders', {
    name: 'Friday release check',
    script: REMINDER,
    interval_s: 7 * 86_400,
    enabled: false,
    subscribe_ea: true,
  })
  await post(request, `/channels/reminders/${created.id}/run`, {})
}

const TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

/** Spreads what the seeding wrote over the last hours before NOW, newest last. */
async function settleTimes(): Promise<void> {
  const db = openSeedDb()
  const stamp = (expr: string) => `to_char((${expr}) AT TIME ZONE 'UTC', ${TIMESTAMP})`
  await db.run(
    `UPDATE channel_event e SET created_at = r.ts, occurred_at = r.ts FROM (SELECT id,
       ${stamp(`?::timestamptz - interval '13 minutes' * (row_number() OVER (ORDER BY id DESC) - 1)`)} AS ts
       FROM channel_event) r WHERE e.id = r.id`,
    at(6),
  )
  await db.run(
    `UPDATE channel_delivery d SET received_at = COALESCE(e.created_at, ?) FROM channel_delivery x
       LEFT JOIN channel_event e ON e.id = x.event_id WHERE d.id = x.id`,
    at(50),
  )
  for (const table of ['channel_poller_run', 'channel_reminder_run']) {
    const every = table === 'channel_poller_run' ? 'p.interval_s' : '3600'
    const join = table === 'channel_poller_run' ? 'JOIN channel_poller p ON p.channel_id = x.channel_id' : ''
    await db.run(
      `UPDATE ${table} t SET started_at = r.ts, due_at = r.ts FROM (SELECT x.id,
         ${stamp(`?::timestamptz - make_interval(secs => ${every}) * (row_number() OVER (PARTITION BY x.channel_id ORDER BY x.id DESC) - 1)`)} AS ts
         FROM ${table} x ${join}) r WHERE t.id = r.id`,
      at(4),
    )
  }
  await db.run(
    `UPDATE ea_inbox SET created_at = ?, due_at = ?, delivered_at = ?,
       acknowledged_at = CASE WHEN acknowledged_at IS NULL THEN NULL ELSE ? END`,
    at(25),
    at(25),
    at(24),
    at(20),
  )
  await db.run(`UPDATE task_message SET created_at = ? WHERE kind = 'input'`, at(2))
  await db.close()
}

/** Every kind of channel with subscribers and recent events, and the EA's inbox already read. */
export async function seedChannels(request: APIRequestContext, baseURL: string, sources: Sources): Promise<void> {
  const secret = await request.post('/api/connections', {
    data: { name: 'helpdesk_token', kind: 'key', env: 'HELPDESK_TOKEN', values: { value: 'hd-demo-0000-0000' } },
  })
  if (!secret.ok()) {
    throw new Error(`helpdesk_token: ${await secret.text()}`)
  }
  const db = openSeedDb()
  await db.run(`UPDATE task SET input_mode = 'queue' WHERE id = ?`, AGENTS.checkout)
  await db.close()
  await seedGithub(request, baseURL)
  await seedDeploys(request, baseURL)
  await seedPollers(request, sources)
  await seedReminder(request)
  const due = await request.get('/api/ea/inbox/due', { headers: EA_HEADERS })
  const ids = ((await due.json()) as Envelope<{ id: number }[]>).data.map((item) => item.id)
  await request.post('/api/ea/inbox/deliver', { headers: EA_HEADERS, data: { ids, via: 'chat' } })
  await request.post('/api/ea/inbox/read', { data: {} })
  await settleTimes()
}
