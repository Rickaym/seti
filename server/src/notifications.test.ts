import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import {
  auditQuery,
  DEFAULT_TIERS,
  NO_CLOSING_LINE,
  VAPID_KEYS_SECRET,
  type NotificationPayload,
  type NotificationStatus,
  type Task,
  type TestNotificationResult,
} from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { firstLine } from './closing-line.js'
import { tasks } from './db.js'
import { resetAttention } from './ea-attention.js'
import { needsYouCount } from './needs-you-count.js'
import { notifyAgent } from './notifications.js'
import { FOCUS_TTL_MS, recordFocus, resetPresence } from './presence.js'
import { secret } from './secrets.js'
import { auditEvents } from './store/audit.js'
import { eaWatches } from './store/inbox.js'
import { secretRows } from './store/secrets.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const FAIL = 'please fail'
const TOKEN = `ghp_${'N0tR'.repeat(9)}`

const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const fake = new fakes.FakeSdk(async function* (current) {
    await Promise.resolve()
    yield fakes.fakeMessage('system', {
      subtype: 'init',
      session_id: 'push',
      model: 'haiku',
      permissionMode: 'default',
    })
    if (current.text.includes('please fail')) {
      yield fakes.fakeResult(true)
      return
    }
    if (current.text.includes('reply quietly')) {
      yield fakes.fakeAssistant('**Opened the PR**\n\nIt waits on review.')
    }
    const said = current.text === 'go' ? `## Shipped the fix\n\nToken ghp_${'N0tR'.repeat(9)} stays out.` : ''
    yield fakes.fakeMessage('result', {
      subtype: 'success',
      is_error: false,
      result: said,
      errors: [],
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 1,
    })
  })
  return { query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()

interface Reply<T> {
  status: number
  data: T
}

async function send<T>(method: string, url: string, body?: unknown): Promise<Reply<T>> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 204) {
    return { status: 204, data: undefined as T }
  }
  const json = (await res.json()) as { data: T }
  return { status: res.status, data: json.data }
}

/** A browser's push keys, kept so the test can read what Seti encrypted to it. */
interface Browser {
  id: string
  endpoint: string
  ecdh: ReturnType<typeof createECDH>
  auth: Buffer
}

let browsers = 0

function browser(host = 'fcm.googleapis.com'): Browser {
  browsers += 1
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    id: `device-${String(browsers).padStart(4, '0')}`,
    endpoint: `https://${host}/fcm/send/${String(browsers)}`,
    ecdh,
    auth: randomBytes(16),
  }
}

const subscription = (b: Browser) => ({
  endpoint: b.endpoint,
  keys: { p256dh: b.ecdh.getPublicKey().toString('base64url'), auth: b.auth.toString('base64url') },
})

async function subscribe(b: Browser): Promise<void> {
  const reply = await send('PUT', `/notifications/devices/${b.id}`, { subscription: subscription(b), label: b.id })
  expect(reply.status).toBe(200)
}

/** Decrypts an aes128gcm push body (RFC 8291) the way the browser would. */
function decrypt(b: Browser, body: Buffer): NotificationPayload {
  const salt = body.subarray(0, 16)
  const idLength = body.readUInt8(20)
  const serverKey = body.subarray(21, 21 + idLength)
  const sealed = body.subarray(21 + idLength)
  const shared = b.ecdh.computeSecret(serverKey)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), b.ecdh.getPublicKey(), serverKey])
  const ikm = Buffer.from(hkdfSync('sha256', shared, b.auth, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString('utf8')) as NotificationPayload
}

interface Push {
  endpoint: string
  headers: Record<string, string>
  body: Buffer
}

let pushes: Push[] = []
let answer = 201

beforeEach(() => {
  pushes = []
  answer = 201
  resetAttention()
  resetPresence()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (!url.includes('/fcm/send/')) {
      return Promise.resolve(new Response(null, { status: 503 }))
    }
    pushes.push({
      endpoint: url,
      headers: init.headers as Record<string, string>,
      body: Buffer.from(init.body as Uint8Array),
    })
    return Promise.resolve(new Response(null, { status: answer }))
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await send('PUT', '/notifications/settings', DEFAULT_TIERS)
  for (const device of (await send<NotificationStatus>('GET', '/notifications')).data.devices) {
    await send('DELETE', `/notifications/devices/${device.device_id}`)
  }
})

let count = 0

async function newTask(): Promise<Task> {
  const id = `push-task-${String(++count)}`
  await tasks.insert({ id, title: `Agent ${String(count)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

async function turn(task: Task, prompt = 'go'): Promise<void> {
  expect((await send('POST', `/tasks/${task.id}/messages`, { prompt })).status).toBe(200)
  await waitIdle(task.id)
}

const delivered = (b: Browser) => pushes.filter((push) => push.endpoint === b.endpoint)

describe('push devices', () => {
  it('saves, lists without endpoint or keys, and removes a device', async () => {
    const phone = browser('web.push.apple.com')
    await subscribe(phone)
    const status = (await send<NotificationStatus>('GET', '/notifications')).data
    expect(status.public_key).toMatch(/^[A-Za-z0-9_-]{80,}$/)
    expect(status.devices).toMatchObject([{ device_id: phone.id, label: phone.id }])
    expect(Date.parse(status.devices[0]?.created_at ?? '')).toBeGreaterThan(0)
    expect(JSON.stringify(status)).not.toContain(phone.endpoint)

    expect((await send('DELETE', `/notifications/devices/${phone.id}`)).status).toBe(204)
    expect((await send<NotificationStatus>('GET', '/notifications')).data.devices).toEqual([])
    expect((await send('DELETE', `/notifications/devices/${phone.id}`)).status).toBe(404)
    expect(
      (await auditEvents.page(auditQuery.parse({ kind: 'system.notifications_changed', limit: 2 }))).events,
    ).toHaveLength(2)
  })

  it('refuses endpoints outside the push services and keys it cannot encrypt to', async () => {
    const elsewhere = browser('example.com')
    const off = await send('PUT', `/notifications/devices/${elsewhere.id}`, {
      subscription: subscription(elsewhere),
      label: 'x',
    })
    expect(off.status).toBe(400)
    const plain = browser()
    const http = { ...subscription(plain), endpoint: plain.endpoint.replace('https:', 'http:') }
    expect((await send('PUT', `/notifications/devices/${plain.id}`, { subscription: http, label: 'x' })).status).toBe(
      400,
    )
    const bad = { ...subscription(plain), keys: { p256dh: 'AAAA', auth: 'AAAA' } }
    expect((await send('PUT', `/notifications/devices/${plain.id}`, { subscription: bad, label: 'x' })).status).toBe(
      400,
    )
    expect(
      (await send('PUT', '/notifications/devices/no', { subscription: subscription(plain), label: 'x' })).status,
    ).toBe(400)
  })

  it('moves an endpoint to the device that subscribed with it last', async () => {
    const first = browser()
    await subscribe(first)
    const again = { ...first, id: 'device-again' }
    await subscribe(again)
    const status = (await send<NotificationStatus>('GET', '/notifications')).data
    expect(status.devices.map((device) => device.device_id)).toEqual(['device-again'])
  })

  it('keeps the key pair sealed in the secret store and never sends the private key', async () => {
    const laptop = browser()
    await subscribe(laptop)
    const row = await secretRows.get(VAPID_KEYS_SECRET)
    expect(row?.sealed).toMatch(/^seti1:/)
    const result = await send<TestNotificationResult>('POST', '/notifications/test', { device_id: laptop.id })
    expect(result.data).toEqual({ sent: 1, failed: 0 })
    const [push] = delivered(laptop)
    if (push === undefined) {
      throw new Error('no push')
    }
    expect(push.headers.Authorization).toMatch(/^vapid t=.+, k=/)
    expect(push.headers['Content-Encoding']).toBe('aes128gcm')
    expect(decrypt(laptop, push.body)).toMatchObject({ title: 'Seti', kind: 'test', tag: 'seti-test' })
    const { privateKey } = JSON.parse((await secret(VAPID_KEYS_SECRET)) ?? '{}') as { privateKey: string }
    expect(privateKey.length).toBeGreaterThan(20)
    const status = JSON.stringify((await send<NotificationStatus>('GET', '/notifications')).data)
    expect(status).not.toContain(privateKey)
    expect(push.body.toString('latin1')).not.toContain(privateKey)
  })

  it('drops a device the push service no longer knows', async () => {
    const gone = browser()
    await subscribe(gone)
    answer = 410
    expect((await send<TestNotificationResult>('POST', '/notifications/test', {})).data).toEqual({ sent: 0, failed: 1 })
    expect((await send<NotificationStatus>('GET', '/notifications')).data.devices).toEqual([])
    expect((await send('POST', '/notifications/test', {})).status).toBe(404)
  })
})

describe('turn notifications', () => {
  it('push a finished turn to every device with the first line of the reply, credentials redacted', async () => {
    const [desk, phone] = [browser(), browser('web.push.apple.com')]
    await subscribe(desk)
    await subscribe(phone)
    const task = await newTask()
    await turn(task)
    await vi.waitFor(() => {
      expect(pushes).toHaveLength(2)
    })
    const [push] = delivered(phone)
    if (push === undefined) {
      throw new Error('no push')
    }
    const payload = decrypt(phone, push.body)
    expect(payload).toEqual({
      title: task.title,
      body: 'Shipped the fix',
      tag: task.id,
      url: `/#agents/${task.id}`,
      kind: 'finished',
      badge: await needsYouCount(),
    })
    expect(push.headers.Topic).toBe(task.id.replaceAll('-', ''))
    expect(push.headers.Urgency).toBe('normal')
    expect((await send<Task>('GET', `/tasks/${task.id}`)).data.closing_line).toBe('Shipped the fix')
    expect(firstLine(`Token ${TOKEN} here`)).not.toContain(TOKEN)
    const { privateKey } = JSON.parse((await secret(VAPID_KEYS_SECRET)) ?? '{}') as { privateKey: string }
    expect(JSON.stringify(payload)).not.toContain(privateKey)
  })

  it("say what finished: the turn's last text without a result, else a phrase, never an older turn", async () => {
    const desk = browser()
    await subscribe(desk)
    const quiet = await newTask()
    await turn(quiet, 'reply quietly')
    await vi.waitFor(() => {
      expect(pushes).toHaveLength(1)
    })
    const silent = await newTask()
    await turn(silent)
    await vi.waitFor(() => {
      expect(pushes).toHaveLength(2)
    })
    await turn(silent, 'say nothing')
    await vi.waitFor(() => {
      expect(pushes).toHaveLength(3)
    })
    const bodies = pushes.map((push) => decrypt(desk, push.body).body)
    expect(bodies).toEqual(['Opened the PR', 'Shipped the fix', NO_CLOSING_LINE])
    expect((await send<Task>('GET', `/tasks/${quiet.id}`)).data.closing_line).toBe('Opened the PR')
    expect((await send<Task>('GET', `/tasks/${silent.id}`)).data.closing_line).toBeNull()
  })

  it('push a failed turn as needs you once, with high urgency', async () => {
    const desk = browser()
    await subscribe(desk)
    const task = await newTask()
    await turn(task, FAIL)
    await vi.waitFor(() => {
      expect(pushes).toHaveLength(1)
    })
    const [push] = pushes
    if (push === undefined) {
      throw new Error('no push')
    }
    const payload = decrypt(desk, push.body)
    expect(payload.kind).toBe('needs_you')
    expect(payload.body).toMatch(/^Failed/)
    expect(payload.badge).toBe(await needsYouCount())
    expect(payload.badge).toBeGreaterThan(0)
    expect(push.headers.Urgency).toBe('high')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(pushes).toHaveLength(1)
  })

  it('skip a muted agent and kinds the settings turn off', async () => {
    await subscribe(browser())
    const muted = await newTask()
    expect((await send<Task>('PATCH', `/tasks/${muted.id}`, { notifications_muted: true })).data).toMatchObject({
      notifications_muted: true,
    })
    expect((await auditEvents.latest('task.notifications_changed'))?.summary).toContain('Muted')
    await turn(muted)
    await send('PUT', '/notifications/settings', { active: 'off' })
    const quiet = await newTask()
    await turn(quiet)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(pushes).toEqual([])
    await turn(quiet, FAIL)
    await vi.waitFor(() => {
      expect(pushes).toHaveLength(1)
    })
  })

  it('skip the device whose page shows the agent, and every device while a page has focus', async () => {
    const [desk, phone] = [browser(), browser()]
    await subscribe(desk)
    await subscribe(phone)
    const task = await tasks.get((await newTask()).id)
    if (task === undefined) {
      throw new Error('no task')
    }
    const at = Date.now()
    recordFocus({ device_id: desk.id, agents: [task.id], active: false }, at)
    expect(await notifyAgent({ ...task, updated_at: 'a' }, 'finished', at)).toBe(1)
    expect(delivered(desk)).toEqual([])

    recordFocus({ device_id: desk.id, agents: [], active: true }, at)
    expect(await notifyAgent({ ...task, updated_at: 'b' }, 'finished', at)).toBe(0)
    expect(delivered(desk)).toEqual([])

    expect(await notifyAgent({ ...task, updated_at: 'c' }, 'finished', at + FOCUS_TTL_MS + 1)).toBe(2)
    expect(delivered(desk)).toHaveLength(1)

    recordFocus({ device_id: desk.id, agents: [], active: false }, at)
    expect(await notifyAgent({ ...task, updated_at: 'd' }, 'finished', at)).toBe(2)
  })

  it("push to Apple with a TTL, a VAPID token for Apple's origin and a body under 4 KB", async () => {
    const phone = browser('web.push.apple.com')
    await subscribe(phone)
    const task = await newTask()
    const longest = { ...task, title: '\u{1F680}'.repeat(200), blocked: 'x'.repeat(500), updated_at: 'apple' }
    expect(await notifyAgent(longest, 'needs_you')).toBe(1)
    const [push] = delivered(phone)
    if (push === undefined) {
      throw new Error('no push')
    }
    expect(push.body.length).toBeLessThan(4096)
    expect(Number(push.headers.TTL)).toBeGreaterThan(0)
    const token = /^vapid t=([^,]+), k=/.exec(push.headers.Authorization ?? '')?.[1] ?? ''
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>
    expect(claims.aud).toBe('https://web.push.apple.com')
    expect(String(claims.sub).startsWith('https://') || String(claims.sub).startsWith('mailto:')).toBe(true)
    expect(Number(claims.exp) - Date.now() / 1000).toBeLessThanOrEqual(24 * 60 * 60)
  })

  it('leave an agent the EA watches to its inbox item, so one event surfaces once', async () => {
    await subscribe(browser())
    const task = await newTask()
    await eaWatches.add(task.id, '', new Date().toISOString())
    expect(await notifyAgent({ ...task, updated_at: 'w1' }, 'finished')).toBe(0)
    expect(await notifyAgent({ ...task, updated_at: 'w2' }, 'needs_you')).toBe(0)
    await eaWatches.remove(task.id)
    expect(await notifyAgent({ ...task, updated_at: 'w3' }, 'finished')).toBe(1)
  })

  it('cap a burst of finished turns, but never an agent that needs you', async () => {
    await subscribe(browser())
    const task = await newTask()
    const sent = []
    for (const stamp of ['1', '2', '3', '4', '5', '6', '7']) {
      sent.push(await notifyAgent({ ...task, updated_at: stamp }, 'finished'))
    }
    expect(sent).toEqual([1, 1, 1, 1, 1, 0, 0])
    expect(await notifyAgent({ ...task, updated_at: '8' }, 'needs_you')).toBe(1)
  })

  it('send one push per agent state, however many listeners report it', async () => {
    await subscribe(browser())
    const task = await newTask()
    await Promise.all([notifyAgent(task, 'needs_you'), notifyAgent(task, 'needs_you')])
    expect(pushes).toHaveLength(1)
  })
})
