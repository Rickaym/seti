import { AUDIT_PAGE_MAX, auditQuery, type AuthSessionInfo, type AuthSettings, type PasskeyInfo } from '@seti/shared'
import type { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccessVerifier } from './access.js'
import { createApp } from './app.js'
import type { CloudflareAccess, PublicAccess } from './config.js'
import { clientNetwork } from './rate-limit.js'
import { createSetupCode, storeEnforced } from './seti-auth.js'
import { auditEvents } from './store/audit.js'
import { USER_AUTH } from './test-auth.js'
import { SoftAuthenticator } from './test-authenticator.js'

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
}))

const CLOUDFLARE: CloudflareAccess = { team: 'myteam.cloudflareaccess.com', aud: 'a'.repeat(64), allowed: null }
const ACCESS: PublicAccess = {
  hostname: 'seti.example.com',
  origin: 'https://seti.example.com',
  cloudflare: CLOUDFLARE,
}
const verify: AccessVerifier = async (token) => {
  if (token !== 'good') {
    throw new Error('bad token')
  }
  return Promise.resolve('me@example.com')
}

const withAccess = createApp({ access: ACCESS, verify })
const withoutAccess = createApp({ access: { ...ACCESS, cloudflare: null }, verify: null })

const ORIGIN = ACCESS.origin
const DAY_MS = 24 * 60 * 60 * 1000
const FAILURES = auditQuery.parse({ kind: 'system.signin_failed', limit: AUDIT_PAGE_MAX })

let ips = 0
/** A fresh client address per browser, so the sign-in rate limit of one test spares the next. */
const browser = () => {
  ips += 1
  return { host: ACCESS.hostname, 'cf-connecting-ip': `203.0.113.${String(ips)}` }
}
const ACCESS_JWT = { 'cf-access-jwt-assertion': 'good' }

type Headers = Record<string, string>

async function call(app: Hono, route: string, headers: Headers, body?: unknown) {
  const [method = 'GET', path = '/'] = route.split(' ')
  return app.request(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

interface Started {
  ceremony: string
  options: { challenge: string }
}

/** Enrolls a passkey as a browser already let in, returning its cookie. */
async function enroll(app: Hono, headers: Headers, key: SoftAuthenticator, name = 'Phone') {
  const writes = { ...headers, origin: key.origin }
  const start = await data<Started>(await call(app, 'POST /api/auth/passkeys/options', writes, {}))
  const res = await call(app, 'POST /api/auth/passkeys', writes, {
    ceremony: start.ceremony,
    name,
    response: key.register(start.options.challenge),
  })
  const passkey = await data<PasskeyInfo>(res)
  return { passkey, cookie: cookieOf(res), res }
}

async function signIn(app: Hono, headers: Headers, key: SoftAuthenticator, tamper?: { origin?: string }) {
  const writes = { ...headers, origin: key.origin }
  const start = await data<Started>(await call(app, 'POST /api/auth/signin/options', writes, {}))
  const response = key.assert(start.options.challenge, tamper?.origin)
  return call(app, 'POST /api/auth/signin', writes, { ceremony: start.ceremony, response })
}

const system = async (app: Hono, headers: Headers) => (await call(app, 'GET /api/system', headers)).status

afterEach(async () => {
  vi.useRealTimers()
  await storeEnforced(false)
})

describe('passkey enrollment', () => {
  it('enrolls through Access and signs that browser in with a host-only, HttpOnly cookie', async () => {
    const client = browser()
    const key = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    const { passkey, res, cookie } = await enroll(withAccess, { ...client, ...ACCESS_JWT }, key)
    expect(passkey).toMatchObject({ name: 'Phone', rp_id: 'seti.example.com' })
    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toMatch(/^__Host-seti_session=[\w-]{43};/)
    expect(header).toMatch(/HttpOnly/)
    expect(header).toMatch(/Secure/)
    expect(header).toMatch(/SameSite=Lax/)
    expect(header).toMatch(/Path=\//)
    expect(await system(withAccess, { ...client, cookie })).toBe(200)
    expect(await auditEvents.latest('system.passkey_added')).toMatchObject({
      detail: { name: 'Phone', rp_id: 'seti.example.com', via: 'public', access_identity: 'me@example.com' },
    })
  })

  it('refuses enrollment to a browser nothing let in', async () => {
    const res = await call(withAccess, 'POST /api/auth/passkeys/options', { ...browser(), origin: ORIGIN }, {})
    expect(res.status).toBe(403)
    const bare = await call(withoutAccess, 'POST /api/auth/passkeys/options', { ...browser(), origin: ORIGIN }, {})
    expect(bare.status).toBe(401)
  })

  it('enrolls the first passkey with a one-time setup code from the host', async () => {
    const client = { ...browser(), origin: ORIGIN }
    const key = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    const { code } = await createSetupCode()
    const start = await data<Started>(await call(withoutAccess, 'POST /api/auth/setup/options', client, { code }))
    const answer = { ceremony: start.ceremony, name: 'Laptop', response: key.register(start.options.challenge) }
    const res = await call(withoutAccess, 'POST /api/auth/setup', client, answer)
    expect(await data(res)).toMatchObject({ signed_in: true, method: 'passkey' })
    expect(await system(withoutAccess, { ...client, cookie: cookieOf(res) })).toBe(200)

    const again = await call(withoutAccess, 'POST /api/auth/setup/options', client, { code })
    expect(again.status).toBe(401)
    const lower = await call(withoutAccess, 'POST /api/auth/setup/options', client, {
      code: code.toLowerCase().replaceAll('-', ''),
    })
    expect(lower.status).toBe(401)
  })

  it('takes a setup code in any case and grouping, and never after 15 minutes', async () => {
    const client = { ...browser(), origin: ORIGIN }
    const { code } = await createSetupCode()
    const typed = code.toLowerCase().replaceAll('-', ' ')
    expect((await call(withoutAccess, 'POST /api/auth/setup/options', client, { code: typed })).status).toBe(200)
    const late = await createSetupCode(new Date(Date.now() - 16 * 60_000))
    const res = await call(withoutAccess, 'POST /api/auth/setup/options', client, { code: late.code })
    expect(res.status).toBe(401)
    expect(await auditEvents.latest('system.signin_failed')).toMatchObject({ detail: { reason: 'bad setup code' } })
  })

  it('uses a setup code up when the passkey is finished, so a second answer fails', async () => {
    const client = { ...browser(), origin: ORIGIN }
    const { code } = await createSetupCode()
    const first = await data<Started>(await call(withoutAccess, 'POST /api/auth/setup/options', client, { code }))
    const second = await data<Started>(await call(withoutAccess, 'POST /api/auth/setup/options', client, { code }))
    const a = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    const b = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    const finish = async (start: Started, key: SoftAuthenticator) =>
      call(withoutAccess, 'POST /api/auth/setup', client, {
        ceremony: start.ceremony,
        name: 'Key',
        response: key.register(start.options.challenge),
      })
    expect((await finish(first, a)).status).toBe(200)
    expect((await finish(second, b)).status).toBe(401)
    expect(await auditEvents.latest('system.signin_failed')).toMatchObject({
      detail: { reason: 'setup code gone', via: 'anonymous' },
    })
  })
})

describe('passkey sign-in', () => {
  it('signs in with an enrolled passkey and rotates the session id', async () => {
    const client = browser()
    const key = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    const { cookie: first } = await enroll(withAccess, { ...client, ...ACCESS_JWT }, key)
    const res = await signIn(withAccess, { ...client, cookie: first }, key)
    expect(await data(res)).toMatchObject({ signed_in: true, method: 'passkey', passkeys: true, local: false })
    const second = cookieOf(res)
    expect(second).not.toBe(first)
    await storeEnforced(true)
    expect(await system(withAccess, { ...client, cookie: second })).toBe(200)
    expect(await system(withAccess, { ...client, cookie: first })).toBe(401)
    expect(await auditEvents.latest('system.signin')).toMatchObject({
      detail: { passkey: 'Phone', host: ACCESS.hostname },
    })
  })

  it('refuses a replayed ceremony, a foreign origin and an unknown passkey, auditing each', async () => {
    const client = browser()
    const key = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    await enroll(withAccess, { ...client, ...ACCESS_JWT }, key)
    const writes = { ...client, origin: ORIGIN }
    const start = await data<Started>(await call(withAccess, 'POST /api/auth/signin/options', writes, {}))
    const answer = { ceremony: start.ceremony, response: key.assert(start.options.challenge) }
    expect((await call(withAccess, 'POST /api/auth/signin', writes, answer)).status).toBe(200)
    expect((await call(withAccess, 'POST /api/auth/signin', writes, answer)).status).toBe(401)
    expect(await auditEvents.latest('system.signin_failed')).toMatchObject({ detail: { reason: 'stale ceremony' } })

    expect((await signIn(withAccess, client, key, { origin: 'https://evil.example.com' })).status).toBe(401)
    const stranger = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    expect((await signIn(withAccess, client, stranger)).status).toBe(401)
    expect(await auditEvents.latest('system.signin_failed')).toMatchObject({ detail: { reason: 'unknown passkey' } })
  })

  it('does not take a passkey of the loopback host on the public host', async () => {
    const local = new SoftAuthenticator('http://localhost:3006', 'localhost')
    const loopback = { host: 'localhost:3006', ...USER_AUTH }
    await enroll(withAccess, loopback, local, 'Desk')
    const res = await signIn(withAccess, { host: 'localhost:3006' }, local)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/^seti_session=/)
    expect(res.headers.get('set-cookie')).not.toMatch(/Secure/)
    const onPublic = new SoftAuthenticator(ORIGIN, 'localhost')
    Object.assign(onPublic, { credentialId: local.credentialId })
    expect((await signIn(withAccess, browser(), onPublic)).status).toBe(401)
  })

  it('limits sign-in attempts per client', async () => {
    const client = { ...browser(), origin: ORIGIN }
    const statuses: number[] = []
    for (let i = 0; i < 21; i += 1) {
      statuses.push((await call(withAccess, 'POST /api/auth/signin/options', client, {})).status)
    }
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true)
    expect(statuses[20]).toBe(429)
    expect((await call(withAccess, 'POST /api/auth/signin/options', { ...browser(), origin: ORIGIN }, {})).status).toBe(
      200,
    )
  })

  it('cannot be drained from many addresses to lock out a fresh client', async () => {
    for (let i = 0; i < 300; i += 1) {
      const swarm = { host: ACCESS.hostname, origin: ORIGIN, 'cf-connecting-ip': `2001:db8:${i.toString(16)}::1` }
      expect((await call(withAccess, 'POST /api/auth/signin/options', swarm, {})).status).toBe(200)
    }
    expect((await call(withAccess, 'POST /api/auth/signin/options', { ...browser(), origin: ORIGIN }, {})).status).toBe(
      200,
    )
  })

  it('counts IPv6 clients by their /64', async () => {
    const from = (ip: string) => ({ host: ACCESS.hostname, origin: ORIGIN, 'cf-connecting-ip': ip })
    for (let i = 0; i < 20; i += 1) {
      await call(withAccess, 'POST /api/auth/signin/options', from(`2001:db8:aa:1::${(i + 1).toString(16)}`), {})
    }
    const sameNet = await call(withAccess, 'POST /api/auth/signin/options', from('2001:db8:aa:1:ffff::9'), {})
    expect(sameNet.status).toBe(429)
    const nextNet = await call(withAccess, 'POST /api/auth/signin/options', from('2001:db8:aa:2::1'), {})
    expect(nextNet.status).toBe(200)
  })

  it('marks refusals as anonymous and audits only a few per client', async () => {
    const before = (await auditEvents.page(FAILURES)).events.length
    const client = { ...browser(), origin: ORIGIN }
    for (let i = 0; i < 25; i += 1) {
      await call(withoutAccess, 'POST /api/auth/setup/options', client, { code: 'WRONG-CODE' })
    }
    const after = await auditEvents.page(FAILURES)
    expect(after.events.length - before).toBe(20)
    expect(after.events[0]?.detail).toMatchObject({ via: 'anonymous', reason: 'bad setup code' })
  })
})

describe('client networks', () => {
  it('keys IPv4 by address and IPv6 by /64, however it is written', () => {
    expect(clientNetwork('203.0.113.7')).toBe('203.0.113.7')
    expect(clientNetwork('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(clientNetwork('2001:db8:0:0:abcd::1')).toBe('2001:db8:0:0::/64')
    expect(clientNetwork('[2001:db8:1:2:3:4:5:6]')).toBe('2001:db8:1:2::/64')
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- an IPv4-mapped documentation address
    expect(clientNetwork('::ffff:198.51.100.4')).toBe('198.51.100.4')
  })
})

describe('sessions', () => {
  it('lists sessions with the current one marked and revokes another', async () => {
    const key = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    const phone = browser()
    const { cookie: mine } = await enroll(withAccess, { ...phone, ...ACCESS_JWT }, key)
    const laptop = browser()
    const other = cookieOf(await signIn(withoutAccess, laptop, key))
    const sessions = await data<AuthSessionInfo[]>(
      await call(withoutAccess, 'GET /api/auth/sessions', { ...phone, cookie: mine }),
    )
    expect(sessions.filter((session) => session.current)).toHaveLength(1)
    const target = sessions.find((session) => !session.current && session.ip === laptop['cf-connecting-ip'])
    expect(target).toBeDefined()
    const revoke = await call(withoutAccess, `DELETE /api/auth/sessions/${target?.id ?? ''}`, {
      ...phone,
      cookie: mine,
      origin: ORIGIN,
    })
    expect(revoke.status).toBe(200)
    expect(await system(withoutAccess, { ...laptop, cookie: other })).toBe(401)
    expect(await system(withoutAccess, { ...phone, cookie: mine })).toBe(200)
    expect(await auditEvents.latest('system.session_revoked')).toMatchObject({ subject_id: target?.id })
  })

  it('signs out the browser it is called from', async () => {
    const key = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    const client = browser()
    const { cookie } = await enroll(withAccess, { ...client, ...ACCESS_JWT }, key)
    const res = await call(withoutAccess, 'POST /api/auth/signout', { ...client, cookie, origin: ORIGIN }, {})
    expect(await data(res)).toMatchObject({ signed_in: false })
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-seti_session=;/)
    expect(await system(withoutAccess, { ...client, cookie })).toBe(401)
  })

  it('ends a session after the idle limit and after the absolute limit, however busy', async () => {
    const key = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    const client = browser()
    const idle = (await enroll(withAccess, { ...client, ...ACCESS_JWT }, key)).cookie
    const busy = cookieOf(await signIn(withAccess, browser(), key))
    const start = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let day = 1; day <= 29; day += 1) {
      vi.setSystemTime(start + day * DAY_MS)
      expect(await system(withoutAccess, { ...client, cookie: busy }), `day ${String(day)}`).toBe(200)
    }
    expect(await system(withoutAccess, { ...client, cookie: idle })).toBe(401)
    vi.setSystemTime(start + 30 * DAY_MS + 1000)
    expect(await system(withoutAccess, { ...client, cookie: busy })).toBe(401)
  })

  it('makes cookie-authenticated writes name Seti as their origin', async () => {
    const key = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    const client = browser()
    const { cookie } = await enroll(withAccess, { ...client, ...ACCESS_JWT }, key)
    const write = async (origin?: string) =>
      (
        await call(
          withoutAccess,
          'PUT /api/user',
          { ...client, cookie, ...(origin === undefined ? {} : { origin }) },
          {
            name: 'Ada',
          },
        )
      ).status
    expect(await write()).toBe(403)
    expect(await write('https://evil.example.com')).toBe(403)
    expect(await write('http://localhost:3006')).toBe(403)
    expect(await write(ORIGIN)).toBe(200)
  })
})

describe('enforcement', () => {
  const settings = async (app: Hono, headers: Headers) =>
    data<AuthSettings>(await call(app, 'GET /api/auth/settings', headers))

  it('cannot be turned on before a passkey signs in to the public host', async () => {
    const app = createApp({
      access: { ...ACCESS, hostname: 'fresh.example.com', origin: 'https://fresh.example.com' },
      verify,
    })
    const client = { host: 'fresh.example.com', ...ACCESS_JWT, 'cf-connecting-ip': '198.51.100.1' }
    expect((await settings(app, client)).enforce_blocked).toMatch(/Add a passkey on fresh.example.com/)
    const res = await call(
      app,
      'PUT /api/auth/enforcement',
      { ...client, origin: 'https://fresh.example.com' },
      {
        enforced: true,
      },
    )
    expect(res.status).toBe(409)
    const key = new SoftAuthenticator('https://fresh.example.com', 'fresh.example.com')
    await enroll(app, client, key)
    const on = await call(
      app,
      'PUT /api/auth/enforcement',
      { ...client, origin: 'https://fresh.example.com' },
      {
        enforced: true,
      },
    )
    expect((await data<AuthSettings>(on)).enforced).toBe(true)
    expect(await auditEvents.latest('system.auth_enforcement_changed')).toMatchObject({ detail: { enforced: true } })
  })

  it('leaves Access in charge while off and requires a passkey session once on', async () => {
    const key = new SoftAuthenticator(ORIGIN, ACCESS.hostname)
    const client = browser()
    const { cookie } = await enroll(withAccess, { ...client, ...ACCESS_JWT }, key)
    expect(await system(withAccess, { ...client, ...ACCESS_JWT })).toBe(200)
    expect(await system(withAccess, client)).toBe(403)
    expect((await call(withAccess, 'GET /', client)).status).toBe(403)

    await data(
      await call(withAccess, 'PUT /api/auth/enforcement', { ...client, cookie, origin: ORIGIN }, { enforced: true }),
    )
    expect(await system(withAccess, { ...client, ...ACCESS_JWT })).toBe(401)
    expect(await system(withAccess, { ...client, cookie })).toBe(200)
    expect((await call(withAccess, 'GET /', { ...client, ...ACCESS_JWT })).status).not.toBe(403)
    expect(await data(await call(withAccess, 'GET /api/auth', client))).toEqual({
      signed_in: false,
      method: null,
      passkeys: true,
      local: false,
    })
  })

  it('keeps the local token working on loopback, whatever the setting', async () => {
    await storeEnforced(true)
    expect(await system(withAccess, { host: '127.0.0.1:3006', ...USER_AUTH })).toBe(200)
    expect(await system(withoutAccess, { host: '127.0.0.1:3006', ...USER_AUTH })).toBe(200)
    expect(await system(withAccess, { host: '127.0.0.1:3006' })).toBe(401)
  })

  it('refuses to remove the last passkey of the enforced public host', async () => {
    const app = createApp({
      access: { ...ACCESS, hostname: 'last.example.com', origin: 'https://last.example.com' },
      verify,
    })
    const client = { host: 'last.example.com', ...ACCESS_JWT, 'cf-connecting-ip': '198.51.100.2' }
    const writes = { ...client, origin: 'https://last.example.com' }
    const first = await enroll(
      app,
      client,
      new SoftAuthenticator('https://last.example.com', 'last.example.com'),
      'One',
    )
    const second = await enroll(
      app,
      client,
      new SoftAuthenticator('https://last.example.com', 'last.example.com'),
      'Two',
    )
    await data(await call(app, 'PUT /api/auth/enforcement', writes, { enforced: true }))
    const cookie = second.cookie
    expect((await call(app, `DELETE /api/auth/passkeys/${first.passkey.id}`, { ...writes, cookie })).status).toBe(200)
    const last = await call(app, `DELETE /api/auth/passkeys/${second.passkey.id}`, { ...writes, cookie })
    expect(last.status).toBe(409)
    await data(await call(app, 'PUT /api/auth/enforcement', { ...writes, cookie }, { enforced: false }))
    expect((await call(app, `DELETE /api/auth/passkeys/${second.passkey.id}`, writes)).status).toBe(200)
    expect(await system(app, { ...client, cookie })).toBe(200)
  })

  it('keeps one passkey when two removals race on the enforced public host', async () => {
    const host = 'race.example.com'
    const app = createApp({ access: { ...ACCESS, hostname: host, origin: `https://${host}` }, verify })
    const client = { host, ...ACCESS_JWT, 'cf-connecting-ip': '198.51.100.3' }
    const writes = { ...client, origin: `https://${host}` }
    const one = await enroll(app, client, new SoftAuthenticator(`https://${host}`, host), 'One')
    const two = await enroll(app, client, new SoftAuthenticator(`https://${host}`, host), 'Two')
    await data(await call(app, 'PUT /api/auth/enforcement', writes, { enforced: true }))
    const local = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
    const statuses = await Promise.all(
      [one, two].map(async ({ passkey }) => (await call(app, `DELETE /api/auth/passkeys/${passkey.id}`, local)).status),
    )
    expect(statuses.toSorted((a, b) => a - b)).toEqual([200, 409])
    const left = await data<PasskeyInfo[]>(await call(app, 'GET /api/auth/passkeys', local))
    expect(left.filter((passkey) => passkey.rp_id === host)).toHaveLength(1)
  })

  it('serves the sign-in page without Access on a host that has none, and nothing else', async () => {
    const client = browser()
    expect((await call(withoutAccess, 'GET /', client)).status).not.toBe(403)
    expect(await system(withoutAccess, { ...client, ...ACCESS_JWT })).toBe(401)
    expect((await call(withoutAccess, 'GET /api/auth', client)).status).toBe(200)
    expect((await settings(withoutAccess, { host: '127.0.0.1:3006', ...USER_AUTH })).cloudflare_access).toBe(false)
  })

  it('renames a passkey and audits it', async () => {
    const client = browser()
    const { passkey, cookie } = await enroll(
      withAccess,
      { ...client, ...ACCESS_JWT },
      new SoftAuthenticator(ORIGIN, ACCESS.hostname),
    )
    const res = await call(
      withAccess,
      `PATCH /api/auth/passkeys/${passkey.id}`,
      { ...client, cookie, origin: ORIGIN },
      {
        name: 'Work phone',
      },
    )
    expect(await data<PasskeyInfo>(res)).toMatchObject({ name: 'Work phone' })
    expect(await auditEvents.latest('system.passkey_renamed')).toMatchObject({
      detail: { name: 'Work phone', previous_name: 'Phone', via: 'passkey', passkey: 'Phone' },
    })
  })
})
