import { createHmac } from 'node:crypto'
import { senderDefinition, WEBHOOK_SENDERS, webhookSenderById, type SenderDefinition } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { readSenderEvent, senderAdapter } from './sender-adapter.js'
import { checkSender, verifySender } from './sender-verify.js'
import type { WebhookRequest } from './types.js'

const NOW = Date.parse('2026-11-19T12:00:00.000Z')
const T = String(NOW / 1000)
const TEXT_SECRET = ['a', 'fake', 'signing', 'secret', 'for', 'tests'].join('-')
const BASE64_SECRET = `whsec_${Buffer.from('twenty-four fake bytes!!').toString('base64')}`

const mac = (algorithm: string, key: string | Buffer, text: string, encoding: 'hex' | 'base64' = 'hex') =>
  createHmac(algorithm, key).update(text).digest(encoding)

const OTHER_BASE64 = `whsec_${Buffer.from('some other fake bytes').toString('base64')}`

const wrong = (secret: string) => (secret.startsWith('whsec_') ? OTHER_BASE64 : `${secret}x`)

const keyBytes = (secret: string) => Buffer.from(secret.replace('whsec_', ''), 'base64')

const standard = (prefix: string) => (body: string, secret: string) => {
  const signature = mac('sha256', keyBytes(secret), `msg_1.${T}.${body}`, 'base64')
  return { [`${prefix}-id`]: 'msg_1', [`${prefix}-timestamp`]: T, [`${prefix}-signature`]: `v1,${signature}` }
}

const without = (headers: Record<string, string>, name: string) =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name.toLowerCase()))

const hub = (body: string, secret: string) => ({ 'x-hub-signature': `sha256=${mac('sha256', secret, body)}` })
const token = (header: string) => (_body: string, secret: string) => ({ [header]: secret })

interface Case {
  secret: string
  body: string
  /** The headers the app sends, by its documented algorithm. */
  headers: (body: string, secret: string) => Record<string, string>
}

const plain = (headers: Case['headers'], body = '{"type":"x","id":"evt_1"}'): Case => ({
  secret: TEXT_SECRET,
  body,
  headers,
})

const CASES: Record<string, Case> = {
  linear: plain(
    (body, secret) => ({ 'linear-signature': mac('sha256', secret, body), 'linear-delivery': 'd-1' }),
    JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: NOW, data: { title: 'Crash' } }),
  ),
  stripe: plain((body, secret) => {
    const v1 = mac('sha256', secret, `${T}.${body}`)
    return { 'stripe-signature': `t=${T},v1=${v1},v0=${'0'.repeat(64)},payload=a25aefc6` }
  }),
  slack: plain((body, secret) => {
    const v0 = mac('sha256', secret, `v0:${T}:${body}`)
    return { 'x-slack-request-timestamp': T, 'x-slack-signature': `v0=${v0}` }
  }),
  gitlab: { secret: BASE64_SECRET, body: '{"object_kind":"push"}', headers: standard('webhook') },
  'standard-webhooks': { secret: BASE64_SECRET, body: '{"type":"user.created"}', headers: standard('webhook') },
  svix: { secret: BASE64_SECRET, body: '{"event_type":"ping"}', headers: standard('svix') },
  jira: plain(hub),
  bitbucket: plain(hub),
  vercel: plain((body, secret) => ({ 'x-vercel-signature': mac('sha1', secret, body) })),
  shopify: plain((body, secret) => ({ 'x-shopify-hmac-sha256': mac('sha256', secret, body, 'base64') })),
  pagerduty: plain((body, secret) => ({
    'x-pagerduty-signature': `v1=${mac('sha256', 'an-older-secret', body)},v1=${mac('sha256', secret, body)}`,
  })),
  grafana: plain((body, secret) => ({ 'x-grafana-alerting-signature': mac('sha256', secret, body) })),
  cloudflare: plain(token('cf-webhook-auth')),
  zapier: plain(token('x-webhook-token')),
  make: plain(token('x-webhook-token')),
}

const request = (body: string, headers: Record<string, string>): WebhookRequest => ({
  headers: new Headers({ 'content-type': 'application/json', ...headers }),
  body: Buffer.from(body),
})

function definitionOf(id: string): SenderDefinition {
  const sender = webhookSenderById(id)
  if (sender === undefined) {
    throw new Error(`no sender ${id}`)
  }
  return sender.definition
}

describe('catalog senders', () => {
  it('has a signed sample for every sender of the catalog', () => {
    expect(new Set(Object.keys(CASES))).toEqual(new Set(WEBHOOK_SENDERS.map((sender) => sender.id)))
    expect(WEBHOOK_SENDERS[0]?.id).toBe('linear')
  })

  it.each(Object.entries(CASES))('%s verifies what the app signs and nothing else', (id, sample) => {
    const definition = definitionOf(id)
    const headers = sample.headers(sample.body, sample.secret)
    const verify = (body: string, sent: Record<string, string>, secret = sample.secret) =>
      verifySender(definition, request(body, sent), secret, NOW)
    expect(verify(sample.body, headers)).toEqual({ ok: true })
    const tampered = verify(`${sample.body} `, headers)
    if (definition.signature.scheme === 'hmac') {
      expect(tampered).toEqual({ ok: false, reason: 'signature mismatch' })
    }
    expect(verify(sample.body, headers, wrong(sample.secret)).ok).toBe(false)
    expect(verify(sample.body, without(headers, definition.signature.header))).toEqual({
      ok: false,
      reason: 'missing signature',
    })
  })

  it('refuses a signed delivery whose timestamp is too old or far ahead, and says which', () => {
    const stale = (id: string, later: number) => {
      const sample = CASES[id]
      const sent = request(sample?.body ?? '', sample?.headers(sample.body, sample.secret) ?? {})
      return checkSender(definitionOf(id), sent, sample?.secret ?? '', NOW + later * 1000)
    }
    for (const id of ['stripe', 'slack', 'gitlab', 'standard-webhooks', 'svix']) {
      expect(stale(id, 299).verdict, id).toEqual({ ok: true })
      expect(stale(id, 301), id).toEqual({
        verdict: { ok: false, reason: 'too old: sent 301 s ago, over the 300 s limit' },
        signed: true,
      })
      expect(stale(id, -400).verdict, id).toEqual({ ok: false, reason: 'timestamp is 400 s in the future' })
    }
    expect(stale('linear', 60).verdict).toEqual({ ok: true })
    expect(stale('linear', 61).verdict).toEqual({ ok: false, reason: 'too old: sent 61 s ago, over the 60 s limit' })
  })

  it('needs the timestamp and id a sender signs with', () => {
    const { secret, body, headers } = CASES.gitlab ?? plain(hub)
    const noId = without(headers(body, secret), 'webhook-id')
    expect(verifySender(definitionOf('gitlab'), request(body, noId), secret, NOW)).toEqual({
      ok: false,
      reason: 'missing delivery id',
    })
    const noTime = without(headers(body, secret), 'webhook-timestamp')
    expect(verifySender(definitionOf('gitlab'), request(body, noTime), secret, NOW)).toEqual({
      ok: false,
      reason: 'missing timestamp',
    })
    const sig = mac('sha256', TEXT_SECRET, `.${body}`)
    expect(
      verifySender(definitionOf('stripe'), request(body, { 'stripe-signature': `v1=${sig}` }), TEXT_SECRET, NOW),
    ).toEqual({ ok: false, reason: 'missing timestamp' })
  })
})

describe('published test vectors', () => {
  it('Slack: the signing example of its documentation', () => {
    const body =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&' +
      'channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&' +
      'response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&' +
      'trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c'
    const sent = request(body, {
      'x-slack-request-timestamp': '1531420618',
      'x-slack-signature': 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
    })
    const secret = ['8f742231b10e8888', 'abcd99yyyzzz85a5'].join('')
    expect(verifySender(definitionOf('slack'), sent, secret, 1531420618_000)).toEqual({ ok: true })
  })

  it('Jira and Bitbucket: the X-Hub-Signature example both document', () => {
    const sent = request('Hello World!', {
      'x-hub-signature': 'sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9',
    })
    for (const id of ['jira', 'bitbucket']) {
      expect(verifySender(definitionOf(id), sent, "It's a Secret to Everybody", NOW), id).toEqual({ ok: true })
    }
  })

  it('Standard Webhooks and Svix: the vectors of the reference library and of the Svix guide', () => {
    const library = request('{"test": 2432232314}', {
      'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      'webhook-timestamp': '1614265330',
      'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    })
    const librarySecret = ['whsec', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'].join('_')
    expect(verifySender(definitionOf('standard-webhooks'), library, librarySecret, 1614265330_000)).toEqual({
      ok: true,
    })
    expect(verifySender(definitionOf('gitlab'), library, librarySecret, 1614265330_000)).toEqual({ ok: true })
    const guide = request('{"event_type":"ping","data":{"success":true}}', {
      'svix-id': 'msg_loFOjxBNrRLzqYUf',
      'svix-timestamp': '1731705121',
      'svix-signature': 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
    })
    const guideSecret = ['whsec', 'plJ3nmyCDGBKInavdOK15jsl'].join('_')
    expect(verifySender(definitionOf('svix'), guide, guideSecret, 1731705121_000)).toEqual({ ok: true })
  })
})

describe('a custom definition', () => {
  it('covers SHA-512, base64, a prefix and a bearer token, and refuses an inconsistent one', () => {
    const body = '{"a":1}'
    const sha512 = senderDefinition.parse({
      signature: { scheme: 'hmac', header: 'X-Sig', algorithm: 'sha512', encoding: 'base64', prefix: 'sha512=' },
    })
    const header = { 'x-sig': `sha512=${mac('sha512', TEXT_SECRET, body, 'base64')}` }
    expect(verifySender(sha512, request(body, header), TEXT_SECRET, NOW)).toEqual({ ok: true })
    const bearer = senderDefinition.parse({
      signature: { scheme: 'token', header: 'Authorization', prefix: 'Bearer ' },
    })
    expect(verifySender(bearer, request(body, { authorization: `Bearer ${TEXT_SECRET}` }), TEXT_SECRET, NOW).ok).toBe(
      true,
    )
    expect(verifySender(bearer, request(body, { authorization: TEXT_SECRET }), TEXT_SECRET, NOW)).toEqual({
      ok: false,
      reason: 'token mismatch',
    })
    expect(verifySender(bearer, request(body, { authorization: 'Bearer nope' }), TEXT_SECRET, NOW).ok).toBe(false)
    const hmac = { scheme: 'hmac', header: 'X-Sig' }
    expect(senderDefinition.safeParse({ signature: { ...hmac, signed: '{timestamp}.{body}' } }).success).toBe(false)
    expect(senderDefinition.safeParse({ signature: { ...hmac, signed: '{id}.{timestamp}.{body}' } }).success).toBe(
      false,
    )
    expect(senderDefinition.safeParse({ signature: hmac, timestamp: { in: 'signature', name: 't' } }).success).toBe(
      false,
    )
    expect(senderDefinition.safeParse({ signature: hmac, title: ['data..title'] }).success).toBe(false)
    expect(senderDefinition.safeParse({ signature: hmac, title: ['a[0]'] }).success).toBe(false)
  })
})

describe('reading an event', () => {
  const names = { sender: 'Linear', channel: 'Tracker' }

  it('names the event with its action and takes the title, link and text from their paths', () => {
    const payload = {
      type: 'Issue',
      action: 'create',
      url: 'https://linear.app/acme/issue/ENG-1',
      data: { title: 'Login fails\non Safari', description: 'Steps: open the page.' },
    }
    expect(readSenderEvent(definitionOf('linear'), payload, new Headers(), names)).toMatchObject({
      source: 'Linear',
      kind: 'Issue.create',
      title: 'Login fails',
      url: 'https://linear.app/acme/issue/ENG-1',
      detail: 'Steps: open the page.',
      severity: 'info',
    })
  })

  it('falls back along the paths, then to the event name, and passes on a capped payload', () => {
    const linear = definitionOf('linear')
    const comment = { type: 'Comment', action: 'create', data: { body: 'Agreed.' }, url: 'javascript:alert(1)' }
    expect(readSenderEvent(linear, comment, new Headers(), names)).toMatchObject({ title: 'Agreed.', url: null })
    const bare = readSenderEvent(linear, { type: 'Cycle' }, new Headers(), names)
    expect(bare).toMatchObject({ kind: 'Cycle', title: 'Linear Cycle', detail: '{"type":"Cycle"}' })
    expect(readSenderEvent(linear, {}, new Headers(), names).title).toBe('Event from Tracker')
    const capped = senderDefinition.parse({ signature: { scheme: 'hmac', header: 'X-Sig' }, detail_max: 20 })
    const long = readSenderEvent(capped, { text: 'x'.repeat(500) }, new Headers(), names)
    expect(long.detail).toHaveLength(20)
    const shopify = readSenderEvent(
      definitionOf('shopify'),
      { title: 'Mug' },
      new Headers({ 'x-shopify-topic': 'products/update' }),
      names,
    )
    expect(shopify).toMatchObject({ kind: 'products/update', title: 'Mug' })
    const grafana = {
      status: 'firing',
      alerts: [{ labels: { alertname: 'HighCPU' }, generatorURL: 'https://g.example/a' }],
    }
    expect(readSenderEvent(definitionOf('grafana'), grafana, new Headers(), names)).toMatchObject({
      kind: 'firing',
      title: 'HighCPU',
      url: 'https://g.example/a',
    })
    expect(
      readSenderEvent(linear, { type: { toString: 'x' }, __proto__: { action: 'y' } }, new Headers(), names).kind,
    ).toBe('')
  })
})

describe('the sample a sender signs for the Test button', () => {
  it.each(WEBHOOK_SENDERS.map((sender) => sender.id))('%s verifies and reads its own sample', (id) => {
    const secret = CASES[id]?.secret ?? TEXT_SECRET
    const adapter = senderAdapter('App', definitionOf(id))
    const sample = adapter.sample(secret, 'nonce-1')
    const sent = request(sample.body, sample.headers)
    expect(adapter.verify(sent, secret, Date.now())).toEqual({ ok: true })
    expect(adapter.verify(sent, wrong(secret), Date.now()).ok).toBe(false)
    expect(adapter.deliveryId(sent)).toBe(definitionOf(id).id === null ? null : 'nonce-1')
    const decoded = adapter.decode(sent)
    expect(decoded.ok && adapter.handshake?.(decoded.payload)).toBeNull()
  })

  it('answers a URL check only for the payload the definition names', () => {
    const slack = senderAdapter('Slack', definitionOf('slack'))
    expect(slack.handshake?.({ type: 'url_verification', challenge: 'abc123' })).toBe('abc123')
    expect(slack.handshake?.({ type: 'event_callback', challenge: 'abc123' })).toBeNull()
    expect(slack.handshake?.({ type: 'url_verification', challenge: { a: 1 } })).toBeNull()
    expect(slack.handshake?.({ type: 'url_verification', challenge: 'x'.repeat(257) })).toBeNull()
    expect(
      senderAdapter('Linear', definitionOf('linear')).handshake?.({ type: 'url_verification', challenge: 'a' }),
    ).toBeNull()
  })
})
