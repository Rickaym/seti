import { createHmac, randomUUID } from 'node:crypto'
import {
  senderDefinition,
  type ChannelInfo,
  type ChannelSecret,
  type SenderSampleResult,
  type WebhookChannelInfo,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { asAgent } from '../access.js'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { checkSenderSample, createChannel, updateChannel } from './actions.js'
import { createReceiver } from './receiver.js'
import { webhooks } from './service.js'
import { auditEvents } from '../store/audit.js'
import { channelStore } from '../store/channels.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { withBundledMods } from '../test-mods.js'

withBundledMods()

const LINEAR_SECRET = ['lin', 'wh', 'fake', 'signing', 'secret'].join('_')
const SLACK_SECRET = ['fake', 'slack', 'signing', 'secret'].join('-')
const HOST = { host: '127.0.0.1:3006', 'content-type': 'application/json' }

const hex = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('hex')

const app = createApp()

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function api<T>(method: string, path: string, body?: unknown, auth: Record<string, string> = USER_AUTH) {
  const res = await app.request(`/api/channels${path}`, {
    method,
    headers: { ...HOST, ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as { data: T; error?: { detail: string } }
  return { status: res.status, data: json.data, error: json.error?.detail ?? '' }
}

const hook = async (path: string, body: string, headers: Record<string, string>) =>
  app.request(path, { method: 'POST', headers: { ...HOST, ...headers }, body })

const linearBody = (at: number, title = 'Login fails') =>
  JSON.stringify({
    type: 'Issue',
    action: 'create',
    url: 'https://linear.app/acme/issue/ENG-1',
    webhookTimestamp: at,
    data: { title, description: 'Steps to reproduce.' },
  })

const linearHeaders = (body: string, delivery: string, secret = LINEAR_SECRET) => ({
  'linear-signature': hex(secret, body),
  'linear-delivery': delivery,
  'linear-event': 'Issue',
})

async function linear(name: string): Promise<WebhookChannelInfo> {
  const created = await api<ChannelSecret>('POST', '', { name, preset: 'linear', secret: LINEAR_SECRET })
  expect(created.status, created.error).toBe(200)
  expect(created.data.secret).toBeNull()
  return created.data.channel
}

const card = async (id: string) => webhooks.info(id)

describe('a catalog sender', () => {
  it('takes the URL first and the secret after, and refuses deliveries until it is pasted', async () => {
    const created = await api<ChannelSecret>('POST', '', { name: 'Tracker', preset: 'linear', subscribe_ea: true })
    expect(created.data).toMatchObject({
      secret: null,
      channel: {
        preset: 'linear',
        secret_pending: 'paste',
        sender: { label: 'Linear', signature: 'Linear-Signature' },
      },
    })
    const { channel } = created.data
    const body = linearBody(Date.now())
    const early = await hook(channel.path, body, linearHeaders(body, 'd-0'))
    expect(early.status).toBe(401)
    const pasted = await api<ChannelSecret>('POST', `/${channel.id}/rotate`, { secret: LINEAR_SECRET })
    expect(pasted.data).toMatchObject({ secret: null, channel: { secret_pending: null } })
    expect(JSON.stringify(pasted.data)).not.toContain(LINEAR_SECRET)
    const res = await hook(channel.path, body, linearHeaders(body, 'd-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { status: 'accepted', reason: 'sent to the EA inbox' }, meta: {} })
    const [event] = await channelStore.recent(channel.id, 5)
    expect(event).toMatchObject({
      kind: 'issue.create',
      title: 'Login fails',
      source: 'Linear',
      url: 'https://linear.app/acme/issue/ENG-1',
      detail: 'Steps to reproduce.',
    })
    const made = await auditEvents.latest('system.channel_created')
    expect(made?.summary).toBe('Created the Linear webhook Tracker')
    const rotated = await auditEvents.latest('system.channel_secret_rotated')
    expect(rotated?.summary).toBe('Rotated the secret of the webhook Tracker')
    expect(JSON.stringify([made, rotated])).not.toContain(LINEAR_SECRET)
  })

  it('records why it refused a delivery, without its body, and takes each delivery id once', async () => {
    const channel = await linear('Refusals')
    const body = linearBody(Date.now(), 'Private text')
    expect((await hook(channel.path, body, linearHeaders(body, 'd-1'))).status).toBe(200)
    const replay = await hook(channel.path, body, linearHeaders(body, 'd-1'))
    expect(await replay.json()).toMatchObject({ data: { status: 'duplicate' } })
    const forged = await hook(channel.path, body, linearHeaders(body, 'd-2', 'some-other-secret-value'))
    expect(forged.status).toBe(401)
    expect(await forged.json()).toEqual({ error: { title: 'Refused', detail: 'signature mismatch' } })
    const tampered = await hook(channel.path, `${body} `, linearHeaders(body, 'd-3'))
    expect(tampered.status).toBe(401)
    expect((await hook(channel.path, body, { 'linear-delivery': 'd-4' })).status).toBe(401)
    const old = linearBody(Date.now() - 5 * 60_000)
    const stale = await hook(channel.path, old, linearHeaders(old, 'd-5'))
    expect(stale.status).toBe(401)
    const log = (await channelStore.deliveries(channel.id, 10)).map((entry) => [entry.status, entry.reason])
    expect(log).toEqual([
      ['rejected', expect.stringMatching(/^too old: sent 30\d s ago, over the 60 s limit$/)],
      ['rejected', 'missing signature'],
      ['rejected', 'signature mismatch'],
      ['rejected', 'signature mismatch'],
      ['duplicate', 'delivery seen in the last 24 hours'],
      ['accepted', 'stored; no subscribers'],
    ])
    const refused = (await channelStore.deliveries(channel.id, 10)).filter((entry) => entry.status === 'rejected')
    expect(refused.map((entry) => entry.excerpt)).toEqual(['', '', '', ''])
    expect(await channelStore.recent(channel.id, 10)).toHaveLength(1)
  })

  it('answers Slack URL check only when it is signed, as plain text', async () => {
    const created = await api<ChannelSecret>('POST', '', { name: 'Chat', preset: 'slack', secret: SLACK_SECRET })
    const { channel } = created.data
    const body = JSON.stringify({ token: 'x', challenge: 'challenge-text-1', type: 'url_verification' })
    const at = String(Math.floor(Date.now() / 1000))
    const digest = hex(SLACK_SECRET, `v0:${at}:${body}`)
    const signature = `v0=${digest}`
    const res = await hook(channel.path, body, { 'x-slack-request-timestamp': at, 'x-slack-signature': signature })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('challenge-text-1')
    const unsigned = await hook(channel.path, body, { 'x-slack-request-timestamp': at })
    expect(unsigned.status).toBe(401)
    expect(await unsigned.text()).not.toContain('challenge-text-1')
    expect((await card(channel.id)).deliveries.map((entry) => entry.reason)).toEqual([
      'missing signature',
      "answered the sender's URL check",
    ])
    expect(await channelStore.recent(channel.id, 5)).toEqual([])
  })

  it('checks stale timestamps against the receiver clock', async () => {
    const channel = await linear('Clock')
    const record = await channelStore.get(channel.id)
    const clock = { at: Date.parse('2026-09-28T12:00:00.000Z') }
    const receiver = createReceiver({ route: async () => Promise.resolve([]), now: () => new Date(clock.at) })
    const body = linearBody(clock.at)
    const send = async (delivery: string) =>
      receiver.receive(
        record?.id ?? '',
        new Request('http://127.0.0.1/hooks/x', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...linearHeaders(body, delivery) },
          body,
        }),
      )
    expect((await send('c-1')).status).toBe('accepted')
    clock.at += 61_000
    expect(await send('c-2')).toMatchObject({ http: 401, status: 'rejected' })
  })
})

const CUSTOM = {
  signature: { scheme: 'hmac', header: 'X-Acme-Signature', prefix: 'sha256=' },
  id: { in: 'header', name: 'X-Acme-Delivery' },
  secret: 'generated',
  event: { in: 'header', name: 'X-Acme-Event' },
  action: 'action',
  title: ['subject'],
  link: ['link'],
} as const

describe('a custom sender', () => {
  it('is created with its definition, verifies with it and can be changed, each audited', async () => {
    expect((await api('POST', '', { name: 'No rules', preset: 'custom' })).status).toBe(400)
    expect((await api('POST', '', { name: 'Two', preset: 'linear', sender: CUSTOM })).status).toBe(400)
    const created = await api<ChannelSecret>('POST', '', { name: 'Acme', preset: 'custom', sender: CUSTOM })
    expect(created.status, created.error).toBe(200)
    const { channel, secret } = created.data
    expect(secret).toMatch(/^whsec_/)
    expect(channel).toMatchObject({
      preset: 'custom',
      sender: { label: 'Custom', signature: 'X-Acme-Signature', secret: 'generated' },
      sender_definition: { signature: { algorithm: 'sha256', encoding: 'hex' }, max_age_s: 300 },
    })
    const body = JSON.stringify({ action: 'opened', subject: 'Ticket 7', link: 'https://acme.example/t/7' })
    const headers = { 'x-acme-event': 'ticket', 'x-acme-delivery': 'a-1' }
    const signed = { ...headers, 'x-acme-signature': `sha256=${hex(secret ?? '', body)}` }
    expect((await hook(channel.path, body, signed)).status).toBe(200)
    expect((await channelStore.recent(channel.id, 5))[0]).toMatchObject({
      kind: 'ticket.opened',
      title: 'Ticket 7',
      source: 'Acme',
      url: 'https://acme.example/t/7',
    })
    const test = await api<WebhookChannelInfo>('POST', `/${channel.id}/test`, {})
    expect(test.status, test.error).toBe(200)

    const changed = await api<WebhookChannelInfo>('PUT', `/${channel.id}`, {
      sender: { ...CUSTOM, signature: { ...CUSTOM.signature, header: 'X-Acme-Sig' } },
    })
    expect(changed.data.sender.signature).toBe('X-Acme-Sig')
    expect((await hook(channel.path, body, { ...signed, 'x-acme-delivery': 'a-2' })).status).toBe(401)
    expect((await auditEvents.latest('system.channel_changed'))?.summary).toBe('Changed the webhook Acme: sender')
    const generic = await api<ChannelSecret>('POST', '', { name: 'Plain', preset: 'generic' })
    expect((await api('PUT', `/${generic.data.channel.id}`, { sender: CUSTOM })).status).toBe(400)
  })
})

describe('the sample check', () => {
  it('checks a pasted request with the sealed secret and says what it would make', async () => {
    const channel = await linear('Sampled')
    const body = linearBody(Date.now(), 'From a log')
    const headers = `Content-Type: application/json\nLinear-Signature: ${hex(LINEAR_SECRET, body)}\nnot a header`
    const good = await api<SenderSampleResult>('POST', '/sample', {
      channel_id: channel.id,
      headers,
      body: `${body}\n`,
    })
    expect(good.data).toEqual({
      verified: true,
      reason: '',
      event: { kind: 'issue.create', title: 'From a log', url: 'https://linear.app/acme/issue/ENG-1' },
    })
    const bad = await api<SenderSampleResult>('POST', '/sample', { channel_id: channel.id, headers, body: `${body}x` })
    expect(bad.data).toEqual({ verified: false, reason: 'signature mismatch', event: null })
    const none = await api<SenderSampleResult>('POST', '/sample', { channel_id: channel.id, headers: '', body })
    expect(none.data).toEqual({ verified: false, reason: 'missing signature', event: null })
    const old = linearBody(Date.now() - 3_600_000)
    const captured = await api<SenderSampleResult>('POST', '/sample', {
      channel_id: channel.id,
      headers: `linear-signature: ${hex(LINEAR_SECRET, old)}`,
      body: old,
    })
    expect(captured.data).toMatchObject({ verified: true, event: { kind: 'issue.create' } })
    expect(captured.data.reason).toMatch(/^A live delivery like this is refused: too old: sent 360\d s ago/)
    expect(await channelStore.deliveries(channel.id, 5)).toEqual([])
    expect(await channelStore.recent(channel.id, 5)).toEqual([])
  })

  it('checks a definition before any webhook exists, with the secret typed beside it', async () => {
    const body = '{"subject":"Ticket 9"}'
    const input = { definition: CUSTOM, headers: `X-Acme-Signature: sha256=${hex('typed-secret', body)}`, body }
    const good = await api<SenderSampleResult>('POST', '/sample', { ...input, secret: 'typed-secret' })
    expect(good.data).toEqual({ verified: true, reason: '', event: { kind: '', title: 'Ticket 9', url: null } })
    expect((await api<SenderSampleResult>('POST', '/sample', { ...input, secret: 'wrong' })).data.verified).toBe(false)
    expect((await api('POST', '/sample', input)).status).toBe(400)
    expect((await api('POST', '/sample', { headers: '', body })).status).toBe(400)
    const generic = await api<ChannelSecret>('POST', '', { name: 'Seti signed', preset: 'generic' })
    const refused = await api('POST', '/sample', { channel_id: generic.data.channel.id, headers: '', body })
    expect(refused.status).toBe(400)
  })
})

describe("what stays the user's", () => {
  it('lets the EA create a catalog webhook but never set its secret, its rules or check a sample', async () => {
    const made = await api<ChannelSecret>('POST', '', { name: 'EA tracker', preset: 'linear' }, EA_AUTH)
    expect(made.status, made.error).toBe(200)
    expect(made.data).toMatchObject({ secret: null, channel: { secret_pending: 'paste' } })
    const { id } = made.data.channel
    const refusals = [
      await api('POST', '', { name: 'X', preset: 'linear', secret: LINEAR_SECRET }, EA_AUTH),
      await api('POST', '', { name: 'X', preset: 'custom', sender: CUSTOM }, EA_AUTH),
      await api('POST', `/${id}/rotate`, { secret: LINEAR_SECRET }, EA_AUTH),
      await api('PUT', `/${id}`, { sender: CUSTOM }, EA_AUTH),
      await api('POST', '/sample', { channel_id: id, headers: '', body: '{}' }, EA_AUTH),
      await api('POST', '/sample', { definition: CUSTOM, secret: 'typed-secret', headers: '', body: '{}' }, EA_AUTH),
    ]
    expect(refusals.map((res) => res.status)).toEqual([403, 403, 403, 403, 403, 403])
    const listed = (await api<ChannelInfo[]>('GET', '', undefined, EA_AUTH)).data
    expect(JSON.stringify(listed)).not.toContain(LINEAR_SECRET)
  })

  it('lets an agent create a catalog webhook but never set its secret, its rules or check a sample', async () => {
    const id = randomUUID()
    await tasks.insert({
      id,
      title: 'Keeper',
      repo_id: null,
      cwd: '/tmp',
      worktree: false,
      pr_urls: [],
      seti_control: 'full',
    })
    const agent = { id, title: 'Keeper', seti_control: 'full' as const }
    const base = { subscribe_ea: false, mapping: {} }
    const made = await asAgent(agent, async () => createChannel({ ...base, name: 'Agent tracker', preset: 'linear' }))
    expect(made).toMatchObject({ secret: null, channel: { secret_pending: 'paste' } })
    const definition = (
      await webhooks.create({ ...base, name: 'Mine', preset: 'custom', sender: senderDefinition.parse(CUSTOM) })
    ).channel
    const refused: (() => Promise<unknown>)[] = [
      async () => createChannel({ ...base, name: 'X', preset: 'linear', secret: LINEAR_SECRET }),
      async () => createChannel({ ...base, name: 'X', preset: 'custom', sender: senderDefinition.parse(CUSTOM) }),
      async () => updateChannel(definition.id, { sender: senderDefinition.parse(CUSTOM) }),
      async () => checkSenderSample({ channel_id: made.channel.id, headers: '', body: '{}' }),
    ]
    for (const attempt of refused) {
      await expect(asAgent(agent, attempt)).rejects.toMatchObject({ status: 403 })
    }
  })
})
