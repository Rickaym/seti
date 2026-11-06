import type { ChannelEvent, ChannelInfo, ChannelSecret } from '@seti/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { sql } from '../db.js'
import { createReceiver, HOOK_BODY_MAX } from './receiver.js'
import { routeEvent } from './router.js'
import { webhooks } from './service.js'
import { hmacHex } from './signature.js'
import { auditEvents } from '../store/audit.js'
import { channelStore } from '../store/channels.js'
import { eaInbox } from '../store/inbox.js'
import { USER_AUTH } from '../test-auth.js'
import { withBundledMods } from '../test-mods.js'

withBundledMods()

const SENTRY_SECRET = ['sentry', 'client', 'secret', 'for', 'tests'].join('-')
const FAKE_TOKEN = `ghp_${'x'.repeat(36)}`
const HOUR_MS = 60 * 60 * 1000

interface Harness {
  receiver: ReturnType<typeof createReceiver>
  routed: ChannelEvent[]
  clock: { at: number }
}

function harness(limits = { perChannel: 1000, global: 1000, windowMs: 60_000 }): Harness {
  const routed: ChannelEvent[] = []
  const clock = { at: Date.parse('2026-09-28T12:00:00.000Z') }
  const receiver = createReceiver({
    route: async (event) => {
      routed.push(event)
      return routeEvent(event)
    },
    limits,
    now: () => new Date(clock.at),
  })
  return { receiver, routed, clock }
}

async function generic(name = 'Alerts', subscribeEa = true): Promise<{ id: string; secret: string }> {
  const created = await webhooks.create({ name, preset: 'generic', subscribe_ea: subscribeEa, mapping: {} })
  if (created.secret === null) {
    throw new Error('a generic webhook gets a generated secret')
  }
  return { id: created.channel.id, secret: created.secret }
}

const signed = (secret: string, payload: unknown, headers: Record<string, string> = {}) => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return new Request('http://127.0.0.1/hooks/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-seti-signature': `sha256=${hmacHex(secret, body)}`, ...headers },
    body,
  })
}

const deliveries = async (id: string) => channelStore.deliveries(id, 50)

describe('webhook receiver', () => {
  it('stores and routes a signed delivery and records it with a scrubbed excerpt', async () => {
    const h = harness()
    const { id, secret } = await generic()
    const payload = { title: 'api is slow', message: `p95 at 3 s; token=${FAKE_TOKEN}`, severity: 'warning' }
    const result = await h.receiver.receive(id, signed(secret, payload, { 'x-seti-delivery': 'd-1' }))
    expect(result).toEqual({ http: 200, status: 'accepted', reason: 'sent to the EA inbox' })
    expect(h.routed).toHaveLength(1)
    expect(h.routed[0]).toMatchObject({ channel: id, title: 'api is slow', severity: 'warning', source: 'Alerts' })
    expect(h.routed[0]?.detail).not.toContain(FAKE_TOKEN)
    const [delivery] = await deliveries(id)
    expect(delivery).toMatchObject({
      status: 'accepted',
      http_status: 200,
      delivery_id: 'd-1',
      event_id: h.routed[0]?.id,
      routes: [{ target: 'ea', task_id: null, label: 'EA', outcome: 'delivered', reason: 'Queued in the EA inbox' }],
    })
    expect(delivery?.excerpt).toContain('api is slow')
    expect(delivery?.excerpt).not.toContain(FAKE_TOKEN)
    expect(delivery?.excerpt).not.toContain(secret)
  })

  it('refuses missing and bad signatures and records why, without the body', async () => {
    const h = harness()
    const { id, secret } = await generic()
    const unsigned = new Request('http://127.0.0.1/hooks/x', { method: 'POST', body: '{"title":"x"}' })
    expect(await h.receiver.receive(id, unsigned)).toMatchObject({ http: 401, reason: 'missing signature' })
    const forged = signed(`${secret}x`, { title: 'x' })
    expect(await h.receiver.receive(id, forged)).toMatchObject({ http: 401, reason: 'signature mismatch' })
    const bearer = new Request('http://127.0.0.1/hooks/x', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      body: '{"title":"by bearer"}',
    })
    expect(await h.receiver.receive(id, bearer)).toMatchObject({ http: 200, status: 'accepted' })
    const rows = await deliveries(id)
    expect(rows.map((row) => [row.status, row.reason, row.excerpt])).toEqual([
      ['accepted', 'sent to the EA inbox', '{"title":"by bearer"}'],
      ['rejected', 'signature mismatch', ''],
      ['rejected', 'missing signature', ''],
    ])
    expect(h.routed.map((event) => event.title)).toEqual(['by bearer'])
  })

  it('drops replays by delivery id or body hash for a day, then takes them again', async () => {
    const h = harness()
    const { id, secret } = await generic()
    const send = async (payload: unknown, headers: Record<string, string> = {}) =>
      (await h.receiver.receive(id, signed(secret, payload, headers))).status
    expect(await send({ title: 'a' }, { 'x-seti-delivery': 'same' })).toBe('accepted')
    expect(await send({ title: 'b' }, { 'x-seti-delivery': 'same' })).toBe('duplicate')
    expect(await send({ title: 'c' })).toBe('accepted')
    expect(await send({ title: 'c' })).toBe('duplicate')
    h.clock.at += 25 * HOUR_MS
    expect(await send({ title: 'c' })).toBe('accepted')
    expect(h.routed.map((event) => event.title)).toEqual(['a', 'c', 'c'])
    const [latest, duplicate] = await deliveries(id)
    expect(latest?.delivery_id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(duplicate?.reason).toBe('delivery seen in the last 24 hours')
  })

  it('caps bodies at 256 KB, declared or streamed, and refuses other types and broken JSON', async () => {
    const h = harness()
    const { id, secret } = await generic()
    const big = JSON.stringify({ title: 'x', pad: 'y'.repeat(HOOK_BODY_MAX) })
    expect(await h.receiver.receive(id, signed(secret, big))).toMatchObject({ http: 413, reason: 'body over 256 KB' })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) {
          controller.enqueue(new Uint8Array(64 * 1024))
        }
        controller.close()
      },
    })
    const streamed = new Request('http://127.0.0.1/hooks/x', { method: 'POST', body: stream, duplex: 'half' })
    expect((await h.receiver.receive(id, streamed)).http).toBe(413)
    const form = signed(secret, 'a=1', { 'content-type': 'application/x-www-form-urlencoded' })
    expect(await h.receiver.receive(id, form)).toMatchObject({ http: 415, status: 'rejected' })
    expect((await h.receiver.receive(id, signed(secret, '{broken'))).http).toBe(400)
    expect(h.routed).toEqual([])
  })

  it('rate-limits each channel and all hooks, and records one refusal per window', async () => {
    const h = harness({ perChannel: 2, global: 5, windowMs: 60_000 })
    const first = await generic('First')
    const second = await generic('Second')
    const send = async (hook: { id: string; secret: string }, n: number) =>
      h.receiver.receive(hook.id, signed(hook.secret, { title: `n${String(n)}` }))
    const results = []
    for (let n = 0; n < 4; n++) {
      results.push(await send(first, n))
    }
    expect(results.map((result) => result.http)).toEqual([200, 200, 429, 429])
    expect(results[2]?.retryAfterS).toBe(60)
    const limited = (await deliveries(first.id)).filter((row) => row.status === 'rate_limited')
    expect(limited).toHaveLength(1)
    expect((await send(second, 0)).http).toBe(200)
    expect((await send(second, 1)).http).toBe(429)
    h.clock.at += 60_000
    expect((await send(second, 2)).http).toBe(200)
  })

  it('answers unknown and malformed ids with 404 and writes nothing', async () => {
    const h = harness()
    const before = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM channel_delivery`)[0]?.n
    expect((await h.receiver.receive('A'.repeat(24), signed('x', {}))).http).toBe(404)
    expect((await h.receiver.receive('../api/system', signed('x', {}))).http).toBe(404)
    const after = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM channel_delivery`)[0]?.n
    expect(after).toBe(before)
  })

  it('stores events of a channel without subscribers and says nobody took them', async () => {
    const h = harness()
    const { id, secret } = await generic('Quiet', false)
    const result = await h.receiver.receive(id, signed(secret, { title: 'noted' }))
    expect(result).toMatchObject({ status: 'accepted', reason: 'stored; no subscribers' })
    expect(await eaInbox.due(new Date(h.clock.at + 1000).toISOString(), 50)).not.toContainEqual(
      expect.objectContaining({ title: 'noted' }),
    )
    expect((await channelStore.recent(id, 5)).map((event) => event.title)).toEqual(['noted'])
    expect((await deliveries(id))[0]?.routes).toEqual([])
  })

  it('routes only changes of a subject state: a first up is a baseline', async () => {
    const h = harness()
    const { id, secret } = await generic()
    let n = 0
    const send = async (state: string) => {
      n += 1
      return h.receiver.receive(id, signed(secret, { title: `api ${state}`, service: 'api', state, n }))
    }
    expect(await send('up')).toMatchObject({ status: 'ignored', reason: 'first report is up; kept as the baseline' })
    expect((await send('down')).status).toBe('accepted')
    expect(await send('down')).toMatchObject({ status: 'duplicate', reason: 'state unchanged: still down' })
    expect((await send('up')).status).toBe('accepted')
    expect(h.routed.map((event) => `${event.subject ?? ''} ${event.state ?? ''}`)).toEqual(['api down', 'api up'])
  })

  it('records verified deliveries with nothing to report as ignored', async () => {
    const h = harness()
    const created = await webhooks.create({
      name: 'Repo',
      preset: 'github-webhooks.github',
      subscribe_ea: true,
      mapping: {},
    })
    const secret = created.secret ?? ''
    const body = '{"zen":"hi"}'
    const ping = new Request('http://127.0.0.1/hooks/x', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': 'g-1',
        'x-hub-signature-256': `sha256=${hmacHex(secret, body)}`,
      },
      body,
    })
    expect(await h.receiver.receive(created.channel.id, ping)).toEqual({ http: 200, status: 'ignored', reason: 'ping' })
    expect(h.routed).toEqual([])
  })
})

describe('webhook routes', () => {
  const app = createApp()
  const headers = { host: '127.0.0.1:3006', ...USER_AUTH, 'content-type': 'application/json' }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
  const api = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/channels${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, data: ((await res.json()) as { data: T }).data }
  }
  const hook = async (path: string, secret: string, payload: unknown, extra: Record<string, string> = {}) => {
    const body = JSON.stringify(payload)
    return app.request(path, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3006',
        'content-type': 'application/json',
        'x-seti-signature': `sha256=${hmacHex(secret, body)}`,
        ...extra,
      },
      body,
    })
  }

  beforeEach(async () => {
    await sql`DELETE FROM ea_inbox`
  })

  it('shows a generated secret once, never in the list, and audits the creation', async () => {
    const created = await api<ChannelSecret>('POST', '', { name: 'Uptime', preset: 'generic' })
    expect(created.status).toBe(200)
    const { channel, secret } = created.data
    expect(secret).toMatch(/^whsec_/)
    expect(channel).toMatchObject({
      name: 'Uptime',
      preset: 'generic',
      subscriptions: [],
      path: `/hooks/${channel.id}`,
    })
    const list = await api<ChannelInfo[]>('GET', '')
    expect(list.data.map((info) => info.id)).toContain(channel.id)
    expect(JSON.stringify(list.data)).not.toContain(secret ?? '-')
    const event = await auditEvents.latest('system.channel_created')
    expect(event).toMatchObject({ subject_id: channel.id, detail: { channel: 'Uptime', preset: 'generic' } })
    expect(JSON.stringify(event)).not.toContain(secret ?? '-')
  })

  it('takes a sender-issued secret for Sentry and refuses secrets where Seti generates them', async () => {
    expect((await api('POST', '', { name: 'S', preset: 'sentry' })).status).toBe(400)
    expect((await api('POST', '', { name: 'G', preset: 'generic', secret: SENTRY_SECRET })).status).toBe(400)
    const sentry = await api<ChannelSecret>('POST', '', {
      name: 'Sentry',
      preset: 'sentry',
      secret: SENTRY_SECRET,
      subscribe_ea: true,
    })
    expect(sentry.data.secret).toBeNull()
    const body = JSON.stringify({ action: 'triggered', data: { event: { title: 'Boom', level: 'error' } } })
    const res = await app.request(sentry.data.channel.path, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3006',
        'content-type': 'application/json',
        'sentry-hook-resource': 'event_alert',
        'sentry-hook-signature': hmacHex(SENTRY_SECRET, body),
      },
      body,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { status: 'accepted', reason: 'sent to the EA inbox' }, meta: {} })
  })

  it('routes a delivery into the EA inbox like any channel event', async () => {
    const created = await api<ChannelSecret>('POST', '', { name: 'Status page', preset: 'generic', subscribe_ea: true })
    const { channel, secret } = created.data
    const res = await hook(channel.path, secret ?? '', {
      title: 'checkout is down',
      service: 'checkout',
      status: 'down',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const [item] = await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 10)
    expect(item).toMatchObject({
      kind: 'channel_event',
      event: 'down',
      title: 'checkout is down',
      severity: 'critical',
      source: 'Status page',
      urgent: true,
    })
    const info = await api<ChannelInfo[]>('GET', '')
    const shown = info.data.find((entry) => entry.id === channel.id)
    expect(shown?.recent.map((event) => event.title)).toEqual(['checkout is down'])
    expect(shown?.deliveries.map((delivery) => delivery.status)).toEqual(['accepted'])
  })

  it('queues webhook events as urgent by the inbox rule: critical, or a subject going down', async () => {
    const { channel, secret } = (
      await api<ChannelSecret>('POST', '', { name: 'Grafana', preset: 'generic', subscribe_ea: true })
    ).data
    const send = async (payload: Record<string, string>) => hook(channel.path, secret ?? '', payload)
    await send({ title: 'db slow', severity: 'warning' })
    await send({ title: 'db down', severity: 'warning', service: 'db', status: 'down' })
    await send({ title: 'disk full', severity: 'critical' })
    const items = await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 10)
    expect(Object.fromEntries(items.map((item) => [item.title, item.urgent]))).toEqual({
      'db slow': false,
      'db down': true,
      'disk full': true,
    })
  })

  it('rotates the secret with an audit entry; the old one stops working', async () => {
    const created = await api<ChannelSecret>('POST', '', { name: 'Rotating', preset: 'generic' })
    const { channel, secret: old } = created.data
    const rotated = await api<ChannelSecret>('POST', `/${channel.id}/rotate`, {})
    const fresh = rotated.data.secret ?? ''
    expect(fresh).toMatch(/^whsec_/)
    expect(fresh).not.toBe(old)
    expect(rotated.data.channel.secret_rotated_at).not.toBeNull()
    expect((await hook(channel.path, old ?? '', { title: 'old' })).status).toBe(401)
    expect((await hook(channel.path, fresh, { title: 'new' })).status).toBe(200)
    const event = await auditEvents.latest('system.channel_secret_rotated')
    expect(event).toMatchObject({ subject_id: channel.id, summary: 'Rotated the secret of the webhook Rotating' })
    expect(JSON.stringify(event)).not.toContain(fresh)
  })

  it('changes settings and the generic field mapping with an audit entry', async () => {
    const created = await api<ChannelSecret>('POST', '', { name: 'Mapped', preset: 'generic', subscribe_ea: true })
    const { channel, secret } = created.data
    const mapping = { title: '/alert/name' }
    const [ea] = channel.subscriptions
    expect((await api('DELETE', `/${channel.id}/subscriptions/${String(ea?.id)}`)).status).toBe(200)
    const put = await api<ChannelInfo>('PUT', `/${channel.id}`, { mapping })
    expect(put.data).toMatchObject({ subscriptions: [], mapping })
    expect(await auditEvents.latest('system.channel_changed')).toMatchObject({
      detail: { channel: 'Mapped', changed: ['mapping'] },
    })
    expect((await api('PUT', `/${channel.id}`, { mapping: { title: 'alert.name' } })).status).toBe(400)
    expect((await api('PUT', `/${channel.id}`, {})).status).toBe(400)
    await hook(channel.path, secret ?? '', { title: 'plain', alert: { name: 'mapped title' } })
    const info = (await api<ChannelInfo[]>('GET', '')).data.find((entry) => entry.id === channel.id)
    expect(info?.recent[0]?.title).toBe('mapped title')
    expect(await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 10)).toEqual([])

    const github = await api<ChannelSecret>('POST', '', { name: 'Repo', preset: 'github' })
    expect((await api('PUT', `/${github.data.channel.id}`, { mapping })).status).toBe(400)
  })

  it('sends a signed test event through the same checks', async () => {
    const created = await api<ChannelSecret>('POST', '', { name: 'Testable', preset: 'github', subscribe_ea: true })
    const tested = await api<ChannelInfo>('POST', `/${created.data.channel.id}/test`, {})
    expect(tested.data.deliveries[0]).toMatchObject({ status: 'accepted' })
    expect(tested.data.recent[0]?.title).toBe('Issue #1 opened: Test event from Seti')
    const [item] = await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 10)
    expect(item).toMatchObject({ kind: 'channel_event', source: 'GitHub seti/test' })
  })

  it('deletes a webhook with an audit entry; its URL and events go with it', async () => {
    const created = await api<ChannelSecret>('POST', '', { name: 'Doomed', preset: 'generic' })
    const { channel, secret } = created.data
    await hook(channel.path, secret ?? '', { title: 'last words' })
    expect((await api('DELETE', `/${channel.id}`)).status).toBe(200)
    expect(await auditEvents.latest('system.channel_deleted')).toMatchObject({
      subject_id: channel.id,
      detail: { channel: 'Doomed', preset: 'generic' },
    })
    expect((await hook(channel.path, secret ?? '', { title: 'again' })).status).toBe(404)
    expect(await channelStore.recent(channel.id, 5)).toEqual([])
    expect((await api('DELETE', `/${channel.id}`)).status).toBe(404)
    expect((await api('PUT', '/not-an-id', { name: 'x' })).status).toBe(400)
  })

  it('answers only POST under /hooks, with JSON and the security headers', async () => {
    const created = await api<ChannelSecret>('POST', '', { name: 'Methods', preset: 'generic' })
    const res = await app.request(created.data.channel.path, { headers: { host: '127.0.0.1:3006' } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
  })
})
