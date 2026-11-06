import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import {
  OFFICIAL_ANDROID_APP,
  type DeviceInfo,
  type DevicePaired,
  type PairingCode,
  type WidgetSummary,
} from '@seti/shared'
import type { Hono } from 'hono'
import { SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import type { AccessVerifier } from './access.js'
import { createApp } from './app.js'
import type { PublicAccess } from './config.js'
import { tasks } from './db.js'
import type { Db } from './pg.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { migrateWith } from './test-migration.js'

vi.mock('./runner.js', () => ({
  runTurn: () => undefined,
  stopTurn: async () => Promise.resolve(),
  endSession: async () => Promise.resolve(),
  isRunning: () => false,
  registerContextProvider: () => undefined,
  registerSessionMcpServers: () => undefined,
  registerTurnPreface: () => undefined,
  onTurnEnd: () => undefined,
  subscribe: () => () => undefined,
  openQuerySince: () => null,
}))

const ACCESS: PublicAccess = {
  hostname: 'seti.example.com',
  origin: 'https://seti.example.com',
  cloudflare: { team: 'myteam.cloudflareaccess.com', aud: 'a'.repeat(64), allowed: null },
}
const verify: AccessVerifier = async (token) => {
  if (token !== 'good') {
    throw new Error('bad token')
  }
  return Promise.resolve('me@example.com')
}
const app = createApp({ access: ACCESS, verify })

const ORIGIN = ACCESS.origin
const SUMMARY = `${ORIGIN}/api/widget/summary`
const PUBLIC = { host: ACCESS.hostname }
const LOCAL = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }

type Headers = Record<string, string>

async function call(target: Hono, route: string, headers: Headers, body?: unknown) {
  const [method = 'GET', path = '/'] = route.split(' ')
  return target.request(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

interface Phone {
  id: string
  key: KeyObject
}

const p256 = () => generateKeyPairSync('ec', { namedCurve: 'P-256' })
const spki = (key: KeyObject) => key.export({ type: 'spki', format: 'der' }).toString('base64url')

const pairingCode = async () => data<PairingCode>(await call(app, 'POST /api/devices/pairing', LOCAL, {}))

let clients = 0
const client = () => {
  clients += 1
  return { ...PUBLIC, 'cf-connecting-ip': `198.51.100.${String(clients)}` }
}

async function pair(name = 'Pixel'): Promise<Phone> {
  const { code } = await pairingCode()
  const keys = p256()
  const body = { code, name, platform: 'android', public_key: spki(keys.publicKey) }
  const paired = await data<DevicePaired>(await call(app, 'POST /api/devices/pair', client(), body))
  return { id: paired.device_id, key: keys.privateKey }
}

interface Claims {
  htm?: string
  htu?: string
  iat?: number
  jti?: string
}

async function proof(phone: Phone, claims: Claims = {}, kid: string = phone.id, key: KeyObject = phone.key) {
  const jws = await new SignJWT({
    htm: claims.htm ?? 'GET',
    htu: claims.htu ?? SUMMARY,
    jti: claims.jti ?? randomBytes(16).toString('base64url'),
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'seti-device+jwt', kid })
    .setIssuedAt(claims.iat ?? Math.floor(Date.now() / 1000))
    .sign(key)
  return { authorization: `SetiDevice ${jws}` }
}

const summary = async (headers: Headers, path = '/api/widget/summary') =>
  call(app, `GET ${path}`, { ...PUBLIC, ...headers })

describe('device pairing', () => {
  it('pairs with a one-time code, without Access or an Origin, and gives the widget scope', async () => {
    const { code, url } = await pairingCode()
    expect(code).toMatch(/^[\w-]{22}$/)
    expect(url).toBe(`${ORIGIN}/pair#code=${code}`)
    const keys = p256()
    const body = { code, name: 'Pixel', platform: 'android', public_key: spki(keys.publicKey) }
    const paired = await data<DevicePaired>(await call(app, 'POST /api/devices/pair', client(), body))
    expect(paired.scopes).toEqual(['widget'])
    const again = { ...body, public_key: spki(p256().publicKey) }
    expect((await call(app, 'POST /api/devices/pair', client(), again)).status).toBe(401)
    expect(await auditEvents.latest('system.device_paired')).toMatchObject({
      subject_id: paired.device_id,
      detail: { name: 'Pixel', platform: 'android' },
    })
    const listed = await data<DeviceInfo[]>(await call(app, 'GET /api/devices', LOCAL))
    expect(listed.find((device) => device.id === paired.device_id)).toMatchObject({ name: 'Pixel', scopes: ['widget'] })
  })

  it('audits a wrong pairing code as anonymous', async () => {
    const body = { code: 'x'.repeat(22), name: 'Guess', platform: 'android', public_key: spki(p256().publicKey) }
    expect((await call(app, 'POST /api/devices/pair', client(), body)).status).toBe(401)
    expect(await auditEvents.latest('system.device_pair_failed')).toMatchObject({
      detail: { path: '/api/devices/pair', via: 'anonymous' },
    })
  })

  it('cannot be drained from many addresses to block a fresh client', async () => {
    const body = { code: 'y'.repeat(22), name: 'Guess', platform: 'android', public_key: spki(p256().publicKey) }
    for (let i = 0; i < 150; i += 1) {
      const swarm = { ...PUBLIC, 'cf-connecting-ip': `2001:db8:${i.toString(16)}::1` }
      expect((await call(app, 'POST /api/devices/pair', swarm, body)).status).toBe(401)
    }
    await pair()
  })

  it('refuses a key that is not P-256 and an expired code', async () => {
    const { code } = await pairingCode()
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey
    const body = { code, name: 'Odd', platform: 'android', public_key: spki(p384) }
    expect((await call(app, 'POST /api/devices/pair', client(), body)).status).toBe(400)

    const late = await pairingCode()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000)
    const expired = { ...body, code: late.code, public_key: spki(p256().publicKey) }
    expect((await call(app, 'POST /api/devices/pair', client(), expired)).status).toBe(401)
    vi.useRealTimers()
  })

  it('refuses the EA every device route', async () => {
    const ea = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...EA_AUTH }
    expect((await call(app, 'GET /api/devices', ea)).status).toBe(403)
    expect((await call(app, 'POST /api/devices/pairing', ea, {})).status).toBe(403)
  })
})

describe('device proofs', () => {
  it('reads the widget summary with a fresh proof, on the public host and on loopback', async () => {
    const phone = await pair()
    await tasks.insert({
      id: 'widget-asking',
      title: 'Needs an answer',
      repo_id: null,
      cwd: '/',
      worktree: false,
      pr_urls: [],
    })
    await tasks.endTurn('widget-asking', { status: 'idle', last_error: null, asking: true, closing_line: null })
    const body = await data<WidgetSummary>(await summary(await proof(phone)))
    expect(body.needs_you).toContainEqual(
      expect.objectContaining({ task_id: 'widget-asking', reason: 'asking', path: '/#agents/widget-asking' }),
    )
    expect(body.running).toBe(0)
    expect(body.cost_today_usd).toBe(0)
    expect(body.paths).toEqual({ home: '/', agents: '/#agents' })

    const local = await proof(phone, { htu: 'http://127.0.0.1:3006/api/widget/summary' })
    expect((await call(app, 'GET /api/widget/summary', { host: '127.0.0.1:3006', ...local })).status).toBe(200)
    const devices = await data<DeviceInfo[]>(await call(app, 'GET /api/devices', LOCAL))
    expect(devices.find((device) => device.id === phone.id)?.last_seen_at).not.toBeNull()
  })

  it('takes a query that htu leaves out', async () => {
    const phone = await pair()
    expect((await summary(await proof(phone), '/api/widget/summary?fresh=1')).status).toBe(200)
  })

  it('refuses a proof signed by another key, and audits it as anonymous', async () => {
    const phone = await pair()
    expect((await summary(await proof(phone, {}, phone.id, p256().privateKey))).status).toBe(401)
    expect(await auditEvents.latest('system.device_proof_refused')).toMatchObject({
      detail: { reason: 'bad signature', path: '/api/widget/summary', via: 'anonymous' },
    })
  })

  it('refuses a proof issued over a minute ago or ahead', async () => {
    const phone = await pair()
    const now = Math.floor(Date.now() / 1000)
    vi.useFakeTimers({ toFake: ['Date'], now: now * 1000 })
    try {
      expect((await summary(await proof(phone, { iat: now - 61 }))).status).toBe(401)
      expect((await summary(await proof(phone, { iat: now + 61 }))).status).toBe(401)
      expect((await summary(await proof(phone, { iat: now - 50 }))).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a replayed jti', async () => {
    const phone = await pair()
    const once = await proof(phone)
    expect((await summary(once)).status).toBe(200)
    expect((await summary(once)).status).toBe(401)
    const jti = randomBytes(16).toString('base64url')
    expect((await summary(await proof(phone, { jti }))).status).toBe(200)
    expect((await summary(await proof(phone, { jti }))).status).toBe(401)
  })

  it('refuses a revoked device', async () => {
    const phone = await pair()
    expect((await summary(await proof(phone))).status).toBe(200)
    expect((await call(app, `DELETE /api/devices/${phone.id}`, LOCAL)).status).toBe(200)
    expect((await summary(await proof(phone))).status).toBe(401)
    expect(await auditEvents.latest('system.device_revoked')).toMatchObject({ subject_id: phone.id })
  })

  it('refuses a proof made for another method or URL', async () => {
    const phone = await pair()
    expect((await summary(await proof(phone, { htm: 'POST' }))).status).toBe(401)
    expect((await summary(await proof(phone, { htu: `${ORIGIN}/api/system` }))).status).toBe(401)
    expect((await summary(await proof(phone, { htu: `https://evil.example.com/api/widget/summary` }))).status).toBe(401)
    expect(
      (await summary(await proof(phone, { htu: `${SUMMARY}?fresh=1` }), '/api/widget/summary?fresh=1')).status,
    ).toBe(401)
  })

  it('reaches nothing outside the widget scope, even with a valid proof', async () => {
    const phone = await pair()
    for (const route of ['GET /api/system', 'GET /api/tasks', 'GET /api/devices', 'GET /api/auth/passkeys']) {
      const [method = 'GET', path = '/'] = route.split(' ')
      const headers = await proof(phone, { htm: method, htu: `${ORIGIN}${path}` })
      expect((await call(app, route, { ...PUBLIC, ...headers })).status, route).toBe(403)
    }
    const write = await proof(phone, { htm: 'POST', htu: `${ORIGIN}/api/devices/pairing` })
    expect((await call(app, 'POST /api/devices/pairing', { ...PUBLIC, ...write, origin: ORIGIN }, {})).status).toBe(403)
    const install = await proof(phone, { htm: 'POST', htu: `${ORIGIN}/api/plugins/installed` })
    const body = { id: 'datadog@claude-plugins-official' }
    const res = await call(app, 'POST /api/plugins/installed', { ...PUBLIC, ...install, origin: ORIGIN }, body)
    expect(res.status).toBe(403)
  })

  it('does not fall back to Access or the local token when a proof fails', async () => {
    const phone = await pair()
    const bad = await proof(phone, { htm: 'POST' })
    expect((await summary({ ...bad, 'cf-access-jwt-assertion': 'good' })).status).toBe(401)
  })

  it('renames a device and keeps it paired', async () => {
    const phone = await pair('Old')
    const renamed = await data<DeviceInfo>(
      await call(app, `PATCH /api/devices/${phone.id}`, LOCAL, { name: 'Work phone' }),
    )
    expect(renamed.name).toBe('Work phone')
    expect((await summary(await proof(phone))).status).toBe(200)
  })
})

const RELATIONS = ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds']

const statement = (packageName: string, prints: readonly string[]) => ({
  relation: RELATIONS,
  target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: prints },
})

const assetLinks = async () => (await call(app, 'GET /.well-known/assetlinks.json', PUBLIC)).json()

const setAndroid = async (body: unknown) => call(app, 'PUT /api/devices/android', LOCAL, body)

describe('android app links', () => {
  const official = OFFICIAL_ANDROID_APP
  const print = Array.from({ length: 32 }, () => 'ab')
    .join(':')
    .toUpperCase()

  it('serves the official app with no setup, without Access', async () => {
    const links = await call(app, 'GET /.well-known/assetlinks.json', PUBLIC)
    expect(links.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await links.json()).toEqual([statement(official.package_name, official.cert_sha256)])
    expect(await data(await call(app, 'GET /api/devices/android', LOCAL))).toEqual({
      official,
      override: null,
      replace_official: false,
    })
  })

  it('adds a self-built app next to the official one until it replaces it explicitly', async () => {
    const override = { package_name: 'com.example.seti', cert_sha256: [print.toLowerCase()] }
    const saved = await setAndroid({ override, replace_official: false })
    expect(await data(saved)).toEqual({
      official,
      override: { package_name: 'com.example.seti', cert_sha256: [print] },
      replace_official: false,
    })
    expect(await assetLinks()).toEqual([
      statement(official.package_name, official.cert_sha256),
      statement('com.example.seti', [print]),
    ])

    await setAndroid({ override, replace_official: true })
    expect(await assetLinks()).toEqual([statement('com.example.seti', [print])])

    await setAndroid({ override: null, replace_official: false })
    expect(await assetLinks()).toEqual([statement(official.package_name, official.cert_sha256)])
  })

  it('merges a self-built key for the official package into one statement', async () => {
    const override = { package_name: official.package_name, cert_sha256: [print] }
    await setAndroid({ override, replace_official: false })
    expect(await assetLinks()).toEqual([statement(official.package_name, [...official.cert_sha256, print])])
    await setAndroid({ override: null, replace_official: false })
  })

  it('refuses malformed apps and replacing the official app with nothing', async () => {
    const bad = await setAndroid({ override: { package_name: 'seti', cert_sha256: ['nope'] }, replace_official: false })
    expect(bad.status).toBe(400)
    const empty = await setAndroid({
      override: { package_name: 'com.example.seti', cert_sha256: [] },
      replace_official: false,
    })
    expect(empty.status).toBe(400)
    expect((await setAndroid({ override: null, replace_official: true })).status).toBe(400)
    expect(await assetLinks()).toEqual([statement(official.package_name, official.cert_sha256)])
  })

  it('serves the pairing landing page without Access and with no script', async () => {
    const res = await call(app, 'GET /pair', PUBLIC)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Pair with Seti')
    expect(html).not.toContain('<script')
    expect((await call(app, 'GET /', PUBLIC)).status).toBe(403)
  })

  it('sends /agent/<id> browser links to the agent in the hash route', async () => {
    const res = await call(app, 'GET /agent/task-1', { host: '127.0.0.1:3006', ...USER_AUTH })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/#agents/task-1')
  })
})

describe('the android override migration', () => {
  const seed = (packageName: string, prints: string[]) =>
    `INSERT INTO android_app (id, package_name, cert_sha256, updated_at)
      VALUES (1, '${packageName}', '${JSON.stringify(prints)}', '2026-10-19');`
  const rows = async (tx: Db) => tx`SELECT package_name, replace_official FROM android_app`

  it('drops a row that only names the official app', async () => {
    const left = await migrateWith(
      'android_override',
      seed(OFFICIAL_ANDROID_APP.package_name, [...OFFICIAL_ANDROID_APP.cert_sha256]),
      rows,
    )
    expect(left).toEqual([])
  })

  it('keeps a self-built app next to the official one', async () => {
    const print = Array.from({ length: 32 }, () => 'CD').join(':')
    const left = await migrateWith('android_override', seed('com.example.seti', [print]), rows)
    expect(left).toEqual([{ package_name: 'com.example.seti', replace_official: false }])
  })
})
