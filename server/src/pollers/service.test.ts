import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import {
  POLLER_LIMITS,
  type ChannelInfo,
  type PollerChannelInfo,
  type PollerTestResult,
  type TaskInput,
} from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { messages, sql, tasks } from '../db.js'
import { auditEvents } from '../store/audit.js'
import { channelStore } from '../store/channels.js'
import { eaInbox } from '../store/inbox.js'
import { pollerStore } from '../store/pollers.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { keyConnection } from '../test-connections.js'
import { withBundledMods } from '../test-mods.js'
import { runPoller } from './service.js'

withBundledMods()

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-pollers-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  process.env.SETI_POLLER_LOOPBACK = '1'
  return root
})

const SECRET = ['poller', 'test', 'secret', 'service'].join('-')

const feed = { items: [] as { id: number; name: string; state: string }[], fail: false, auth: '' }
let server: http.Server
let host = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    feed.auth = req.headers.authorization ?? ''
    if (feed.fail) {
      res.writeHead(503).end('down')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: feed.items, echo: req.headers.authorization ?? null }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  server.close()
  const { rmSync } = await import('node:fs')
  rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()
const BASE = { host: '127.0.0.1:3006', 'content-type': 'application/json' }

async function send(auth: Record<string, string>, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...BASE, ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: (await res.json()) as { data: unknown; error?: { detail: string } } }
}

async function data<T>(auth: Record<string, string>, method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(auth, method, path, body)
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return res.json.data as T
}

const script = (headers = '{}') => `export default async function poll({ fetch }) {
  const res = await fetch('http://${host}/items', { secretHeaders: ${headers} })
  if (!res.ok) throw new Error('answered ' + res.status)
  const body = await res.json()
  return body.data.map((item) => ({ key: item.id, title: item.name, kind: 'issue', fields: { state: item.state } }))
}`

async function newPoller(name: string, extra: Record<string, unknown> = {}): Promise<PollerChannelInfo> {
  return data<PollerChannelInfo>(USER_AUTH, 'POST', '/channels/pollers', {
    name,
    preset: 'http_json',
    script: script(),
    extra_hosts: [host],
    subscribe_ea: false,
    ...extra,
  })
}

async function queueTask(id: string): Promise<void> {
  await tasks.insert({ id, title: id, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  await tasks.setInputMode(id, 'queue')
}

const inputsOf = async (taskId: string): Promise<TaskInput[]> =>
  (await messages.page(taskId, 100)).messages.flatMap((row) => (row.kind === 'input' ? [row.payload] : []))

describe('poller runs', () => {
  it('leaves a new poller out of the EA inbox unless asked', async () => {
    const plain = await data<PollerChannelInfo>(USER_AUTH, 'POST', '/channels/pollers', {
      name: 'Unasked',
      preset: 'http_json',
      script: script(),
      extra_hosts: [host],
      enabled: false,
    })
    expect(plain.subscriptions).toEqual([])
    const asked = await newPoller('Asked', { subscribe_ea: true, enabled: false })
    expect(asked.subscriptions).toMatchObject([{ target: 'ea', task_id: null }])
  })

  it('records a baseline, then reports new, changed and gone items to its subscribers', async () => {
    feed.items = [{ id: 1, name: 'First', state: 'open' }]
    const poller = await newPoller('Issues', { detect_gone: true, subscribe_ea: true })
    await queueTask('poll-watcher')
    await data(USER_AUTH, 'POST', `/channels/${poller.id}/subscriptions`, {
      target: 'task',
      task_id: 'poll-watcher',
      events: ['issue'],
    })

    expect(await runPoller(poller.id, 'schedule')).toBe(0)
    expect(await channelStore.recent(poller.id, 10)).toEqual([])
    expect((await pollerStore.get(poller.id))?.baseline_at).not.toBeNull()

    feed.items = [
      { id: 1, name: 'First', state: 'closed' },
      { id: 2, name: 'Second', state: 'open' },
    ]
    await runPoller(poller.id, 'schedule')
    const events = await channelStore.recent(poller.id, 10)
    expect(events.map((event) => [event.kind, event.title])).toEqual([
      ['issue', 'Second'],
      ['issue.changed', 'Changed: First'],
    ])
    expect(events[1]?.detail).toBe('state: open -> closed')
    expect(await inputsOf('poll-watcher')).toEqual([
      expect.objectContaining({ source: 'channel', channel: 'Issues', kind: 'issue.changed', title: 'Changed: First' }),
      expect.objectContaining({ source: 'channel', channel: 'Issues', kind: 'issue', title: 'Second' }),
    ])
    const inbox = await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 10)
    expect(inbox.map((item) => item.title)).toEqual(expect.arrayContaining(['Changed: First', 'Second']))
    const [delivery] = await channelStore.deliveries(poller.id, 1)
    expect(delivery).toMatchObject({ status: 'accepted', http_status: 0 })
    expect(delivery?.routes.map((route) => route.label)).toEqual(['EA', 'poll-watcher'])

    feed.items = [{ id: 2, name: 'Second', state: 'open' }]
    await runPoller(poller.id, 'manual')
    expect((await channelStore.recent(poller.id, 1))[0]).toMatchObject({ kind: 'issue.gone', title: 'Gone: First' })
    await runPoller(poller.id, 'manual')
    expect(await channelStore.recent(poller.id, 10)).toHaveLength(3)

    const runs = await pollerStore.runs(poller.id, 10)
    expect(runs.map((run) => [run.trigger, run.ok, run.items, run.emitted])).toEqual([
      ['manual', true, 1, 0],
      ['manual', true, 1, 1],
      ['schedule', true, 2, 2],
      ['schedule', true, 1, 0],
    ])
  })

  it('backs off on failures, tells subscribers once when failing, and once when it recovers', async () => {
    feed.items = [{ id: 1, name: 'One', state: 'open' }]
    const poller = await newPoller('Flaky')
    await runPoller(poller.id, 'schedule')
    feed.fail = true
    const failures: (number | null)[] = []
    for (let i = 0; i < POLLER_LIMITS.failuresBeforeFailing + 1; i++) {
      failures.push(await runPoller(poller.id, 'schedule'))
    }
    expect(failures).toEqual([1, 2, 3, 4, 5, 6])
    const failed = await channelStore.recent(poller.id, 10)
    expect(failed.map((event) => event.kind)).toEqual(['poller_failed'])
    expect(failed[0]).toMatchObject({ severity: 'warning', title: 'Flaky is failing' })
    expect((await data<PollerChannelInfo>(USER_AUTH, 'GET', `/channels/pollers/${poller.id}`)).poller.status).toBe(
      'failing',
    )

    feed.fail = false
    expect(await runPoller(poller.id, 'schedule')).toBe(0)
    const recovered = await channelStore.recent(poller.id, 10)
    expect(recovered.map((event) => event.kind)).toEqual(['poller_recovered', 'poller_failed'])
    expect((await pollerStore.get(poller.id))?.failing).toBe(false)
  })

  it('records a run as failed when Seti cannot finish it, instead of losing it', async () => {
    feed.items = [{ id: 1, name: 'One', state: 'open' }]
    const poller = await newPoller('Half done')
    const broken = vi.spyOn(pollerStore, 'succeeded').mockRejectedValueOnce(new Error('connection reset'))
    expect(await runPoller(poller.id, 'schedule')).toBe(1)
    broken.mockRestore()
    const [run] = await pollerStore.runs(poller.id, 1)
    expect(run).toMatchObject({ ok: false, error: 'Seti could not finish the run: connection reset' })
    expect(await runPoller(poller.id, 'schedule')).toBe(0)
  })

  it('keeps at most the newest keys, and drops keys unseen for 30 days', async () => {
    feed.items = [{ id: 1, name: 'One', state: 'open' }]
    const poller = await newPoller('Big')
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString()
    await sql`INSERT INTO channel_poller_item (channel_id, key, fingerprint, title, first_seen, last_seen)
      SELECT ${poller.id}, 'k' || n, 'f', 't', ${old}, ${new Date(Date.now() - 1000).toISOString()}
      FROM generate_series(1, ${POLLER_LIMITS.keysKept + 5}) AS n`
    await sql`INSERT INTO channel_poller_item (channel_id, key, fingerprint, title, first_seen, last_seen)
      VALUES (${poller.id}, 'stale', 'f', 't', ${old}, ${old})`
    await runPoller(poller.id, 'schedule')
    expect(await pollerStore.keys(poller.id)).toBe(POLLER_LIMITS.keysKept)
    expect((await pollerStore.seen(poller.id)).has('stale')).toBe(false)
    expect((await pollerStore.seen(poller.id)).has('1')).toBe(true)
  })
})

describe('poller secrets', () => {
  it('sends a connection without it reaching runs, events, logs, the audit or the API', async () => {
    await keyConnection('issue_token', SECRET)
    feed.items = [{ id: 1, name: 'One', state: 'open' }]
    const poller = await newPoller('Private', {
      secrets: ['issue_token'],
      subscribe_ea: true,
      script: `export default async function poll({ fetch, log }) {
        const res = await fetch('http://${host}/items', { secretHeaders: { Authorization: 'Bearer {{issue_token}}' } })
        const body = await res.json()
        log('echo', body.echo)
        return body.data.map((item) => ({ key: item.id, title: body.echo, body: JSON.stringify(body) }))
      }`,
    })
    await runPoller(poller.id, 'schedule')
    feed.items.push({ id: 2, name: 'Two', state: 'open' })
    await runPoller(poller.id, 'schedule')
    expect(feed.auth).toBe(`Bearer ${SECRET}`)

    const listed = await send(USER_AUTH, 'GET', '/channels')
    const test = await data<PollerTestResult>(USER_AUTH, 'POST', '/channels/pollers/test', {
      ...(await pollerStore.get(poller.id)),
      channel_id: poller.id,
    })
    expect(test.items[0]?.title).toBe('Bearer [secret]')
    const audit = await auditEvents.latest('system.channel_created')
    const everything = JSON.stringify([
      listed.json,
      test,
      await channelStore.recent(poller.id, 10),
      await channelStore.deliveries(poller.id, 10),
      await pollerStore.runs(poller.id, 10),
      await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 50),
      audit,
    ])
    expect(everything).toContain('[secret]')
    expect(everything).not.toContain(SECRET)
    expect(await data<string[]>(USER_AUTH, 'GET', '/channels/pollers/secrets')).toContain('issue_token')
  })
})

describe('poller routes', () => {
  it('lists pollers with webhooks, polls now, audits and deletes', async () => {
    feed.items = []
    const poller = await newPoller('Routes')
    const listed = await data<ChannelInfo[]>(USER_AUTH, 'GET', '/channels')
    expect(listed.find((info) => info.id === poller.id)).toMatchObject({ source: 'poller', name: 'Routes' })
    expect(await auditEvents.latest('system.channel_created')).toMatchObject({
      subject_id: poller.id,
      summary: 'Created the poller Routes',
    })

    const polled = await data<PollerChannelInfo>(USER_AUTH, 'POST', `/channels/pollers/${poller.id}/poll`)
    expect(polled.poller).toMatchObject({ status: 'ok', runs: [{ trigger: 'manual', ok: true }] })
    expect(await auditEvents.latest('system.channel_polled')).toMatchObject({ subject_id: poller.id })

    const paused = await data<PollerChannelInfo>(USER_AUTH, 'PUT', `/channels/pollers/${poller.id}`, {
      enabled: false,
      interval_s: 600,
    })
    expect(paused.poller).toMatchObject({ status: 'paused', interval_s: 600, next_run_at: null })
    expect(await auditEvents.latest('system.channel_changed')).toMatchObject({
      summary: 'Changed the poller Routes: interval_s, enabled',
    })
    expect((await app.request(`/hooks/${poller.id}`, { method: 'POST', headers: BASE, body: '{}' })).status).toBe(404)

    expect((await send(USER_AUTH, 'DELETE', `/channels/${poller.id}`)).status).toBe(200)
    expect(await pollerStore.get(poller.id)).toBeUndefined()
    expect(await auditEvents.latest('system.channel_deleted')).toMatchObject({ summary: 'Deleted the poller Routes' })
  })

  it('test runs a draft without storing or sending anything', async () => {
    feed.items = [{ id: 5, name: 'Five', state: 'open' }]
    const result = await data<PollerTestResult>(USER_AUTH, 'POST', '/channels/pollers/test', {
      script: script(),
      extra_hosts: [host],
    })
    expect(result).toMatchObject({ ok: true, items: [{ key: '5', title: 'Five', kind: 'issue' }], invalid: [] })
    const refused = await data<PollerTestResult>(USER_AUTH, 'POST', '/channels/pollers/test', { script: script() })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('is not on the allowed hosts')
  })

  it('lets the EA author pollers but not widen their reach or rewrite a script that sends secrets', async () => {
    const reach = { name: 'EA poller', script: script(), extra_hosts: [host] }
    expect((await send(EA_AUTH, 'POST', '/channels/pollers', reach)).json.error?.detail).toBe(
      "The EA cannot change a poller's extra hosts or secrets; the user does that in Seti",
    )
    const mine = await data<PollerChannelInfo>(EA_AUTH, 'POST', '/channels/pollers', {
      name: 'EA poller',
      script: script(),
    })
    expect((await send(EA_AUTH, 'PUT', `/channels/pollers/${mine.id}`, { secrets: ['issue_token'] })).status).toBe(403)
    await data(EA_AUTH, 'PUT', `/channels/pollers/${mine.id}`, { script: script('{ }'), interval_s: 120 })

    await keyConnection('issue_token', SECRET)
    const secretive = await newPoller('Secretive', { secrets: ['issue_token'] })
    const rewrite = await send(EA_AUTH, 'PUT', `/channels/pollers/${secretive.id}`, {
      script: 'export default () => []',
    })
    expect(rewrite.json.error?.detail).toBe(
      'The EA cannot change the script of a poller that uses secrets; the user does that in Seti',
    )
    await data(EA_AUTH, 'PUT', `/channels/pollers/${secretive.id}`, { interval_s: 900 })
    const stealTest = await send(EA_AUTH, 'POST', '/channels/pollers/test', {
      script: 'export default () => []',
      secrets: ['issue_token'],
      extra_hosts: [host],
      channel_id: secretive.id,
    })
    expect(stealTest.status).toBe(403)
    const savedTest = await send(EA_AUTH, 'POST', '/channels/pollers/test', {
      script: script(),
      secrets: ['issue_token'],
      extra_hosts: [host],
      channel_id: secretive.id,
    })
    expect(savedTest.status).toBe(200)
    expect((await send(EA_AUTH, 'DELETE', `/channels/${mine.id}`)).status).toBe(200)
  })
})

describe('poller workers', () => {
  it('keep a script that computes without awaiting off the event loop the API answers on', async () => {
    const test = async (body: string) =>
      data<PollerTestResult>(USER_AUTH, 'POST', '/channels/pollers/test', { script: body })
    expect(await test('export default () => []')).toMatchObject({ ok: true })
    const delay = monitorEventLoopDelay({ resolution: 10 })
    delay.enable()
    const busy = test('export default () => { for (;;) {} }')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const started = performance.now()
    const ping = await app.request('/api/ping', { headers: BASE })
    const pingMs = performance.now() - started
    const result = await busy
    delay.disable()
    expect(result).toMatchObject({ ok: false, error: 'The script computed for over 1000 ms without awaiting' })
    expect(ping.status).toBe(204)
    expect(pingMs).toBeLessThan(100)
    expect(delay.max / 1e6).toBeLessThan(250)
  })
})
