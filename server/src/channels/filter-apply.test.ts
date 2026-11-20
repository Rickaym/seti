import type { ChannelEvent, WebhookChannelInfo, WebhookFilterTestResult } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { createFilterPool } from './filter-run.js'
import { createReceiver } from './receiver.js'
import { webhooks } from './service.js'
import { hmacHex } from './signature.js'
import { auditEvents } from '../store/audit.js'
import { channelStore } from '../store/channels.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'

const workers = createFilterPool(1)
const routed: ChannelEvent[] = []
const receiver = createReceiver({
  route: async (event) => {
    routed.push(event)
    return Promise.resolve([])
  },
  filters: workers,
})
const app = createApp()
const BASE = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', 'content-type': 'application/json' }
const FAKE_TOKEN = `ghp_${'y'.repeat(36)}`

afterAll(async () => {
  await workers.close()
})

async function send<T>(method: string, url: string, body: unknown, auth: Record<string, string> = USER_AUTH) {
  const res = await app.request(`/api${url}`, { method, headers: { ...BASE, ...auth }, body: JSON.stringify(body) })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

async function webhook(name: string): Promise<{ id: string; secret: string }> {
  const created = await webhooks.create({ name, preset: 'generic', subscribe_ea: false, mapping: {} })
  return { id: created.channel.id, secret: created.secret ?? '' }
}

async function deliver({ id, secret }: { id: string; secret: string }, payload: object) {
  const body = JSON.stringify(payload)
  const request = new Request('http://127.0.0.1/hooks/x', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-seti-signature': `sha256=${hmacHex(secret, body)}`,
      'user-agent': 'Tests/1',
    },
    body,
  })
  return receiver.receive(id, request)
}

const setFilter = async (id: string, script: string, more: object = {}) =>
  send<WebhookChannelInfo>('PUT', `/channels/${id}/filter`, { script, enabled: true, ...more })

const DROP_DEPLOYS = "export default (e) => (e.event === 'deploy' ? null : true)"

describe('webhook filters', () => {
  it('drops, keeps and reshapes deliveries before any subscriber sees them', async () => {
    const hook = await webhook('Filtered alerts')
    await setFilter(
      hook.id,
      `export default (e) => {
        if (e.event === 'deploy') return null
        if (e.event === 'incident') return { title: 'Incident: ' + e.title, event: 'incident.open' }
        return true
      }`,
    )
    const before = routed.length
    expect(await deliver(hook, { title: 'v2 shipped', type: 'deploy', note: FAKE_TOKEN })).toMatchObject({
      http: 200,
      status: 'filtered',
      reason: 'filtered out deploy: v2 shipped',
    })
    expect(await deliver(hook, { title: 'api down', type: 'incident' })).toMatchObject({ status: 'accepted' })
    expect(await deliver(hook, { title: 'disk at 80%', type: 'warning' })).toMatchObject({ status: 'accepted' })
    expect(routed.slice(before).map((event) => [event.kind, event.title])).toEqual([
      ['incident.open', 'Incident: api down'],
      ['warning', 'disk at 80%'],
    ])

    const [kept, changed, dropped] = await channelStore.deliveries(hook.id, 3)
    expect(dropped).toMatchObject({
      status: 'filtered',
      excerpt: '',
      filter: { outcome: 'dropped', event: 'deploy', title: 'v2 shipped', error: null },
    })
    expect(changed?.filter).toMatchObject({ outcome: 'changed', event: 'incident', title: 'api down' })
    expect(kept?.filter).toMatchObject({ outcome: 'kept' })
    const info = await webhooks.info(hook.id)
    expect(info.filter?.day).toEqual({ kept: 1, changed: 1, dropped: 1, failed: 0 })
  })

  it('keeps a delivery whose filter fails, logs the error and warns after failures in a row', async () => {
    const hook = await webhook('Broken filter')
    await setFilter(hook.id, "export default (e) => e.payload.missing.field === 'x'")
    for (const n of [1, 2, 3]) {
      const result = await deliver(hook, { title: `alert ${String(n)}`, type: 'alert' })
      expect(result).toMatchObject({ status: 'accepted' })
    }
    const [latest] = await channelStore.deliveries(hook.id, 1)
    expect(latest?.filter).toMatchObject({ outcome: 'failed', title: 'alert 3' })
    expect(latest?.filter?.error).toContain('TypeError')
    expect(latest?.filter?.error).not.toContain('alert 3')
    const failing = await webhooks.info(hook.id)
    expect(failing.filter).toMatchObject({ failures: 3, day: { failed: 3 } })

    await setFilter(hook.id, 'export default () => true')
    expect((await webhooks.info(hook.id)).filter).toMatchObject({ failures: 0, last_error: null })
    await setFilter(hook.id, 'export default () => { throw new Error("x") }')
    expect(await deliver(hook, { title: 'kept on error', type: 'alert' })).toMatchObject({ status: 'accepted' })
    expect((await channelStore.deliveries(hook.id, 1))[0]?.filter?.error).toBe('Error: x (line 1)')
    await setFilter(hook.id, DROP_DEPLOYS, { enabled: false })
    expect(await deliver(hook, { title: 'off', type: 'deploy' })).toMatchObject({ status: 'accepted' })
    expect((await channelStore.deliveries(hook.id, 1))[0]?.filter).toBeNull()
  })

  it('tests code against recent deliveries and a pasted sample, storing nothing', async () => {
    const hook = await webhook('Tested filter')
    await deliver(hook, { title: 'first deploy', type: 'deploy', token: FAKE_TOKEN })
    await deliver(hook, { title: 'an incident', type: 'incident' })
    const deliveriesBefore = await channelStore.deliveries(hook.id, 10)
    const result = await send<WebhookFilterTestResult>('POST', `/channels/${hook.id}/filter/test`, {
      script: `export default (e, { log }) => {
        log(JSON.stringify(e.payload))
        return e.event === 'deploy' ? null : { title: e.title.toUpperCase() }
      }`,
      sample: { headers: 'User-Agent: pasted', body: JSON.stringify({ title: 'pasted deploy', type: 'deploy' }) },
    })
    expect(result.sample_error).toBeNull()
    expect(result.rows.map((row) => [row.source, row.event, row.title, row.outcome])).toEqual([
      ['sample', 'deploy', 'pasted deploy', 'dropped'],
      ['delivery', 'incident', 'an incident', 'changed'],
      ['delivery', 'deploy', 'first deploy', 'dropped'],
    ])
    expect(result.rows[1]?.changed).toEqual({ title: 'AN INCIDENT' })
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN)
    expect(await channelStore.deliveries(hook.id, 10)).toEqual(deliveriesBefore)

    const bad = await send<WebhookFilterTestResult>('POST', `/channels/${hook.id}/filter/test`, {
      script: 'export default () => true',
      sample: { headers: '', body: 'not json' },
    })
    expect(bad.sample_error).toContain('The sample is refused')
  })

  it('keeps samples for the newest 20 deliveries only', async () => {
    const hook = await webhook('Busy webhook')
    for (let n = 0; n < 23; n++) {
      await deliver(hook, { title: `event ${String(n)}`, type: 'tick' })
    }
    const samples = await channelStore.samples(hook.id)
    expect(samples).toHaveLength(20)
    expect(samples[0]?.sample).toContain('event 22')
  })

  it('audits who changed the filter with a hash of the code, never the code, and lets the EA change it', async () => {
    const hook = await webhook('Audited filter')
    const code = "export default (e) => e.title !== 'secret marker'"
    const saved = await setFilter(hook.id, code)
    expect(saved.filter).toMatchObject({ script: code, enabled: true })
    const event = await auditEvents.latest('system.webhook_filter_changed')
    expect(event).toMatchObject({ subject_id: hook.id, actor: 'user' })
    expect(event?.detail).toMatchObject({ channel: 'Audited filter', enabled: true, lines: 1 })
    expect(String(event?.detail.code)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.stringify(event)).not.toContain('secret marker')

    const byEa = await send<WebhookChannelInfo>(
      'PUT',
      `/channels/${hook.id}/filter`,
      { script: DROP_DEPLOYS, enabled: true },
      EA_AUTH,
    )
    expect(byEa.filter?.script).toBe(DROP_DEPLOYS)
    expect((await auditEvents.latest('system.webhook_filter_changed'))?.detail).toMatchObject({ via: 'ea' })

    const removed = await send<WebhookChannelInfo>('PUT', `/channels/${hook.id}/filter`, { script: '', enabled: false })
    expect(removed.filter).toBeNull()
    expect((await auditEvents.latest('system.webhook_filter_changed'))?.summary).toBe(
      'Removed the filter of the webhook Audited filter',
    )
  })

  it('refuses a filter turned on without code', async () => {
    const hook = await webhook('Empty filter')
    const res = await app.request(`/api/channels/${hook.id}/filter`, {
      method: 'PUT',
      headers: { ...BASE, ...USER_AUTH },
      body: JSON.stringify({ script: '  ', enabled: true }),
    })
    expect(res.status).toBe(400)
  })
})
