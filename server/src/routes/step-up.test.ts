import { STEP_UP_REFUSAL, type PasskeyInfo } from '@seti/shared'
import type { Hono } from 'hono'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AccessVerifier } from '../access.js'
import { createApp } from '../app.js'
import type { PublicAccess } from '../config.js'
import { modHost } from '../mods/bundled.js'
import { storeEnforced } from '../seti-auth.js'
import { auditEvents } from '../store/audit.js'
import { SoftAuthenticator } from '../test-authenticator.js'

const ACCESS: PublicAccess = {
  hostname: 'seti.example.com',
  origin: 'https://seti.example.com',
  cloudflare: { team: 'myteam.cloudflareaccess.com', aud: 'a'.repeat(64), allowed: null },
}
const verify: AccessVerifier = async (token) =>
  token === 'good' ? Promise.resolve('me@example.com') : Promise.reject(new Error('bad token'))
const app = createApp({ access: ACCESS, verify })

let ips = 0
const browser = () => {
  ips += 1
  return { host: ACCESS.hostname, origin: ACCESS.origin, 'cf-connecting-ip': `203.0.113.${String(ips)}` }
}

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

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

interface Started {
  ceremony: string
  options: { challenge: string }
}

/** A browser signed in with a fresh passkey, through Access, as the user enrolls one. */
async function signedIn(key: SoftAuthenticator): Promise<Headers> {
  const headers = { ...browser(), 'cf-access-jwt-assertion': 'good' }
  const start = await data<Started>(await call(app, 'POST /api/auth/passkeys/options', headers, {}))
  const res = await call(app, 'POST /api/auth/passkeys', headers, {
    ceremony: start.ceremony,
    name: 'Phone',
    response: key.register(start.options.challenge),
  })
  await data<PasskeyInfo>(res)
  return { ...browser(), cookie: cookieOf(res) }
}

/** Another browser signed in with the same passkey, through the sign-in route. */
async function signedInAgain(key: SoftAuthenticator): Promise<Headers> {
  const headers = { ...browser(), 'cf-access-jwt-assertion': 'good' }
  const start = await data<Started>(await call(app, 'POST /api/auth/signin/options', headers, {}))
  const res = await call(app, 'POST /api/auth/signin', headers, {
    ceremony: start.ceremony,
    response: key.assert(start.options.challenge),
  })
  await data(res)
  return { ...browser(), cookie: cookieOf(res) }
}

async function stepUp(headers: Headers, key: SoftAuthenticator, answerAs: Headers = headers) {
  const start = await data<Started>(await call(app, 'POST /api/auth/step-up/options', headers, {}))
  return call(app, 'POST /api/auth/step-up', answerAs, {
    ceremony: start.ceremony,
    response: key.assert(start.options.challenge),
  })
}

const INSTALL = { mod_id: 'stepped', hash: 'a'.repeat(64) }
const install = async (headers: Headers) => {
  const res = await call(app, 'POST /api/mod-admin/install', headers, INSTALL)
  return { status: res.status, detail: ((await res.json()) as { error?: { detail: string } }).error?.detail }
}

afterEach(async () => {
  vi.useRealTimers()
  await storeEnforced(false)
})

afterAll(() => {
  modHost.stopAll()
})

describe('passkey step-up for consent to mods', () => {
  it('asks a session for a fresh passkey check while Require passkey is on, for five minutes', async () => {
    const key = new SoftAuthenticator(ACCESS.origin, ACCESS.hostname)
    const session = await signedIn(key)
    expect((await install(session)).detail).toBe('Turn on Developer mode in Settings, Mods')
    await storeEnforced(true)
    expect(await install(session)).toEqual({ status: 403, detail: STEP_UP_REFUSAL })

    await data(await stepUp(session, key))
    await auditEvents.settled()
    expect(await auditEvents.latest('system.stepped_up')).toMatchObject({ actor: 'user', detail: { passkey: 'Phone' } })
    expect((await install(session)).detail).toBe('Turn on Developer mode in Settings, Mods')

    vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ['Date'] })
    expect(await install(session)).toEqual({ status: 403, detail: STEP_UP_REFUSAL })
  })

  it('lets only the session that asked finish a check', async () => {
    const key = new SoftAuthenticator(ACCESS.origin, ACCESS.hostname)
    const mine = await signedIn(key)
    const other = await signedInAgain(key)
    await storeEnforced(true)
    expect((await stepUp(mine, key, other)).status).toBe(403)
    expect(await install(other)).toEqual({ status: 403, detail: STEP_UP_REFUSAL })
  })

  it('needs a passkey session to step up at all', async () => {
    const res = await call(
      app,
      'POST /api/auth/step-up/options',
      { ...browser(), 'cf-access-jwt-assertion': 'good' },
      {},
    )
    expect(res.status).toBe(400)
  })
})
