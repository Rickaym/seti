import { Hono } from 'hono'
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type FetchImplementation, type JWK } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { accessGuard, createAccessVerifier, type AccessGuardOptions } from './access.js'
import { createApp } from './app.js'
import { audit } from './audit.js'
import { webhooks } from './channels/service.js'
import { hmacHex } from './channels/signature.js'
import type { CloudflareAccess, PublicAccess } from './config.js'
import { localAuth } from './local-auth.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

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
const ISSUER = `https://${CLOUDFLARE.team}`
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`

interface SigningKey {
  kid: string
  privateKey: CryptoKey
  jwk: JWK
}

async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } }
}

let current: SigningKey
let rotated: SigningKey
let stranger: SigningKey

beforeAll(async () => {
  current = await signingKey('current')
  rotated = await signingKey('rotated')
  stranger = await signingKey('current')
})

afterEach(() => {
  vi.useRealTimers()
})

/** A JWKS endpoint serving `keys()` at call time and counting fetches. */
function jwksServer(keys: () => JWK[]) {
  const urls: string[] = []
  const fetchJwks: FetchImplementation = async (url) => {
    urls.push(url)
    return Promise.resolve(Response.json({ keys: keys() }))
  }
  return { fetchJwks, urls }
}

interface Claims {
  aud?: string | string[]
  iss?: string
  exp?: number
  nbf?: number
  email?: string
}

const nowS = () => Math.floor(Date.now() / 1000)

async function token(key: SigningKey, claims: Claims = {}): Promise<string> {
  const { aud = [CLOUDFLARE.aud], iss = ISSUER, exp = nowS() + 300, nbf, email = 'me@example.com' } = claims
  const jwt = new SignJWT({ email, ...(nbf === undefined ? {} : { nbf }) })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
  return jwt.sign(key.privateKey)
}

describe('createAccessVerifier', () => {
  const verifier = () => {
    const server = jwksServer(() => [current.jwk])
    return { verify: createAccessVerifier(CLOUDFLARE, server.fetchJwks), urls: server.urls }
  }

  it('accepts a token signed by a team key and returns the email', async () => {
    const { verify, urls } = verifier()
    await expect(verify(await token(current))).resolves.toBe('me@example.com')
    await expect(verify(await token(current))).resolves.toBe('me@example.com')
    expect(urls).toEqual([CERTS_URL])
  })

  it('rejects a token for another application', async () => {
    const { verify } = verifier()
    await expect(verify(await token(current, { aud: ['b'.repeat(64)] }))).rejects.toThrow(/aud/)
  })

  it('rejects a token from another team', async () => {
    const { verify } = verifier()
    await expect(verify(await token(current, { iss: 'https://other.cloudflareaccess.com' }))).rejects.toThrow(/iss/)
  })

  it('rejects an expired token beyond the clock skew and accepts one within it', async () => {
    const { verify } = verifier()
    await expect(verify(await token(current, { exp: nowS() - 120 }))).rejects.toThrow(/exp/)
    await expect(verify(await token(current, { exp: nowS() - 5 }))).resolves.toBe('me@example.com')
  })

  it('rejects a token that is not valid yet', async () => {
    const { verify } = verifier()
    await expect(verify(await token(current, { nbf: nowS() + 120 }))).rejects.toThrow(/nbf/)
  })

  it('rejects a bad signature under a known kid', async () => {
    const { verify } = verifier()
    await expect(verify(await token(stranger))).rejects.toThrow(/signature/)
  })

  it('rejects a token whose signature was tampered with', async () => {
    const { verify } = verifier()
    const [header = '', payload = ''] = (await token(current)).split('.')
    const forged = await token(current, { email: 'attacker@example.com' })
    await expect(verify(`${header}.${payload}.${forged.split('.')[2] ?? ''}`)).rejects.toThrow(/signature/)
  })

  it('rejects unsigned and symmetric tokens', async () => {
    const { verify } = verifier()
    const [, payload = ''] = (await token(current)).split('.')
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'current' })).toString('base64url')
    await expect(verify(`${none}.${payload}.`)).rejects.toThrow()
    const hs = await new SignJWT({ email: 'me@example.com' })
      .setProtectedHeader({ alg: 'HS256', kid: 'current' })
      .setIssuer(ISSUER)
      .setAudience(CLOUDFLARE.aud)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('shared secret that is long enough'))
    await expect(verify(hs)).rejects.toThrow(/alg/)
  })

  it('rejects an unknown kid and refetches keys at most once per cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { verify, urls } = verifier()
    await verify(await token(current))
    await expect(verify(await token(rotated))).rejects.toThrow(/no applicable key/)
    await expect(verify(await token(rotated))).rejects.toThrow(/no applicable key/)
    expect(urls).toHaveLength(1)
    vi.advanceTimersByTime(31_000)
    await expect(verify(await token(rotated))).rejects.toThrow(/no applicable key/)
    expect(urls).toHaveLength(2)
  })

  it('picks up a rotated key on an unknown kid', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let keys = [current.jwk]
    const server = jwksServer(() => keys)
    const verify = createAccessVerifier(CLOUDFLARE, server.fetchJwks)
    await verify(await token(current))
    keys = [current.jwk, rotated.jwk]
    vi.advanceTimersByTime(31_000)
    await expect(verify(await token(rotated))).resolves.toBe('me@example.com')
    expect(server.urls).toHaveLength(2)
  })
})

describe('host guard', () => {
  const guarded = (options: AccessGuardOptions) => createApp(options)
  const withAccess = () =>
    guarded({ access: ACCESS, verify: createAccessVerifier(CLOUDFLARE, jwksServer(() => [current.jwk]).fetchJwks) })
  const request = async (app: Hono, path: string, headers: Record<string, string>, method = 'GET') =>
    app.request(path, {
      method,
      headers: method === 'GET' ? headers : { 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: '{}' }),
    })

  it('serves loopback requests with the local token, with and without public access', async () => {
    for (const app of [guarded({ access: null, verify: null }), withAccess()]) {
      expect((await request(app, '/api/system', { host: 'localhost:3006', ...USER_AUTH })).status).toBe(200)
      expect((await request(app, '/api/system', { host: 'seti.localhost:3006', ...USER_AUTH })).status).toBe(200)
      const origin = 'http://seti.localhost:3006'
      const post = { host: 'seti.localhost:3006', origin, ...USER_AUTH }
      expect((await request(app, '/api/nope', post, 'POST')).status).toBe(404)
      const foreign = { host: 'localhost:3006', origin: 'https://seti.example.com', ...USER_AUTH }
      expect((await request(app, '/api/nope', foreign, 'POST')).status).toBe(403)
    }
  })

  it('refuses loopback API requests without a valid local token', async () => {
    for (const app of [guarded({ access: null, verify: null }), withAccess()]) {
      const bare = await request(app, '/api/system', { host: '127.0.0.1:3006' })
      expect(bare.status).toBe(401)
      const wrong = { host: '127.0.0.1:3006', authorization: `Bearer ${'x'.repeat(43)}` }
      expect((await request(app, '/api/system', wrong)).status).toBe(401)
      expect((await request(app, '/api/system', { host: 'localhost', 'x-seti-via': 'ea' })).status).toBe(401)
      const origin = 'http://seti.localhost:3006'
      expect((await request(app, '/api/tasks', { host: 'seti.localhost:3006', origin }, 'POST')).status).toBe(401)
    }
  })

  it('keeps the health check and the UI shell open to loopback callers', async () => {
    const app = guarded({ access: null, verify: null })
    expect((await request(app, '/api/ping', { host: '127.0.0.1:3006' })).status).toBe(204)
    expect((await request(app, '/', { host: 'seti.localhost:3006' })).status).not.toBe(401)
    const state = await request(app, '/api/auth', { host: 'seti.localhost:3006' })
    expect(await state.json()).toEqual({
      data: { signed_in: false, method: null, passkeys: false, local: true },
      meta: {},
    })
  })

  it('accepts the EA token and tags the request as the EA', async () => {
    const app = guarded({ access: null, verify: null })
    expect((await request(app, '/api/system', { host: '127.0.0.1:3006', ...EA_AUTH })).status).toBe(200)
  })

  it('refuses every local caller when the server has no tokens', async () => {
    const app = guarded({ access: null, verify: null, local: localAuth({ user: null, ea: null }) })
    expect((await request(app, '/api/system', { host: '127.0.0.1:3006', ...USER_AUTH })).status).toBe(401)
    expect((await request(app, '/api/system', { host: '127.0.0.1:3006', ...EA_AUTH })).status).toBe(401)
  })

  it('rejects other hosts', async () => {
    for (const app of [guarded({ access: null, verify: null }), withAccess()]) {
      expect((await request(app, '/api/system', { host: 'evil.example.com' })).status).toBe(403)
    }
    const app = guarded({ access: null, verify: null })
    expect((await request(app, '/api/system', { host: 'seti.example.com' })).status).toBe(403)
  })

  it('requires a valid Access token on the public host, for the API and the UI', async () => {
    const app = withAccess()
    const host = { host: 'seti.example.com' }
    expect((await request(app, '/api/system', host)).status).toBe(403)
    expect((await request(app, '/', host)).status).toBe(403)
    const bad = { ...host, 'cf-access-jwt-assertion': await token(current, { aud: 'other' }) }
    expect((await request(app, '/api/system', bad)).status).toBe(403)
    const good = { ...host, 'cf-access-jwt-assertion': await token(current) }
    expect((await request(app, '/api/system', good)).status).toBe(200)
  })

  it('accepts only the public origin for writes on the public host', async () => {
    const app = withAccess()
    const headers = { host: 'seti.example.com', 'cf-access-jwt-assertion': await token(current) }
    const post = async (origin: string) => request(app, '/api/nope', { ...headers, origin }, 'POST')
    expect((await post('https://seti.example.com')).status).toBe(404)
    expect((await post('http://seti.localhost:3006')).status).toBe(403)
    expect((await post('https://evil.example.com')).status).toBe(403)
  })

  it('rejects Cloudflare-forwarded requests that carry a loopback Host', async () => {
    const jwt = await token(current)
    for (const app of [guarded({ access: null, verify: null }), withAccess()]) {
      const forwarded = { host: 'localhost:3006', 'cf-ray': '8f00-AMS', 'cf-access-jwt-assertion': jwt }
      expect((await request(app, '/api/system', forwarded)).status).toBe(403)
      expect((await request(app, '/api/system', { host: 'localhost', 'cdn-loop': 'cloudflare' })).status).toBe(403)
    }
  })

  it('does not serve preview hosts through the tunnel', async () => {
    const app = withAccess()
    const headers = {
      host: 'app-pr-1.seti.localhost',
      'cf-ray': '8f00-AMS',
      'cf-access-jwt-assertion': await token(current),
    }
    expect((await request(app, '/', headers)).status).toBe(403)
  })
})

describe('webhook exemption', () => {
  const tunnel = { host: 'seti.example.com', 'cf-ray': '8f00-AMS', 'content-type': 'application/json' }
  const app = () =>
    createApp({ access: ACCESS, verify: createAccessVerifier(CLOUDFLARE, jwksServer(() => [current.jwk]).fetchJwks) })
  const send = async (target: Hono, path: string, method = 'POST', headers: Record<string, string> = tunnel) =>
    target.request(path, { method, headers, ...(method === 'GET' ? {} : { body: '{"title":"x"}' }) })

  it('lets signed deliveries through the tunnel without an Access token, still checking the signature', async () => {
    const created = await webhooks.create({ name: 'Tunnel', preset: 'generic', subscribe_ea: false, mapping: {} })
    const secret = created.secret ?? ''
    const target = app()
    const signature = { 'x-seti-signature': `sha256=${hmacHex(secret, '{"title":"x"}')}` }
    const accepted = await send(target, created.channel.path, 'POST', { ...tunnel, ...signature })
    expect(accepted.status).toBe(200)
    expect(accepted.headers.get('x-frame-options')).toBe('DENY')
    expect(accepted.headers.get('strict-transport-security')).toMatch(/^max-age=/)
    expect((await send(target, created.channel.path)).status).toBe(401)
    const wrongHost = { ...tunnel, ...signature, host: 'localhost:3006' }
    expect((await send(target, created.channel.path, 'POST', wrongHost)).status).toBe(403)
    const unpublished = createApp({ access: null, verify: null })
    expect((await send(unpublished, created.channel.path, 'POST', { ...tunnel, ...signature })).status).toBe(403)
  })

  it('exempts nothing outside the hooks prefix, however the path is spelled', async () => {
    const target = app()
    const unknownHook = `/hooks/${'a'.repeat(24)}`
    const hooked = await send(target, unknownHook)
    expect(hooked.status).toBe(404)
    expect(await hooked.json()).toEqual({ error: { title: 'Not found', detail: 'no such webhook' } })
    const outside = [
      '/',
      '/api/system',
      '/api/channels',
      '/hooks',
      '/hooksx/abc',
      '/Hooks/abc',
      '/HOOKS/abc',
      '/api/hooks/abc',
      '/x/hooks/abc',
      '/hooks/../api/system',
      '/hooks/%2e%2e/api/system',
      '/hooks/./../api/channels',
      '/index.html',
    ]
    for (const path of outside) {
      for (const method of ['GET', 'POST']) {
        expect((await send(target, path, method)).status, `${method} ${path}`).toBe(403)
      }
    }
    for (const path of ['/hooks/..%2fapi%2fsystem', '/%68ooks/abc', `${unknownHook}/extra`]) {
      const res = await send(target, path, 'GET')
      expect([403, 404], path).toContain(res.status)
      expect(res.headers.get('content-type'), path).toMatch(/^application\/json/)
    }
  })
})

describe('identity allowlist and write log', () => {
  const allowlisted = (allowed: string[]) => {
    const cloudflare = { ...CLOUDFLARE, allowed: new Set(allowed) }
    const access = { ...ACCESS, cloudflare }
    return createApp({ access, verify: createAccessVerifier(cloudflare, jwksServer(() => [current.jwk]).fetchJwks) })
  }
  const asPublic = async (email: string) => ({
    host: 'seti.example.com',
    origin: 'https://seti.example.com',
    'cf-access-jwt-assertion': await token(current, { email }),
  })

  it('lets in only allowlisted identities, ignoring case', async () => {
    const app = allowlisted(['me@example.com'])
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect((await app.request('/api/system', { headers: await asPublic('Me@Example.com') })).status).toBe(200)
    const refused = await app.request('/api/system', { headers: await asPublic('intruder@example.com') })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({
      error: { detail: 'This Access identity is not allowed on this Seti' },
    })
    expect(stderr).toHaveBeenCalledWith('access: refused GET /api/system for intruder@example.com\n')
    stderr.mockRestore()
  })

  it('logs each public write with its identity and status, and no reads', async () => {
    const app = allowlisted(['me@example.com'])
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const headers = await asPublic('me@example.com')
    await app.request('/api/system', { headers })
    const post = await app.request('/api/nope', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(post.status).toBe(404)
    expect(stdout.mock.calls.map(([line]) => line)).toEqual(['access: POST /api/nope 404 by me@example.com\n'])
    stdout.mockRestore()
  })

  it('leaves loopback requests to the local token', async () => {
    const app = allowlisted(['me@example.com'])
    expect((await app.request('/api/system', { headers: { host: 'localhost:3006', ...USER_AUTH } })).status).toBe(200)
  })
})

describe('audit actor detail', () => {
  it('marks user actions that came through the public host', async () => {
    const app = new Hono()
    app.use(
      '*',
      accessGuard({
        access: ACCESS,
        verify: createAccessVerifier(CLOUDFLARE, jwksServer(() => [current.jwk]).fetchJwks),
      }),
    )
    app.post('/act', async (c) => {
      await audit.record({ actor: 'user', kind: 'repo.added', subject_type: 'repo', summary: 'Added repo' })
      return c.body(null, 204)
    })
    await app.request('/act', { method: 'POST', headers: { host: 'localhost' } })
    expect((await auditEvents.latest('repo.added'))?.detail).toEqual({ via: 'anonymous' })
    const headers = { host: 'seti.example.com', 'cf-access-jwt-assertion': await token(current) }
    await app.request('/act', { method: 'POST', headers })
    expect((await auditEvents.latest('repo.added'))?.detail).toEqual({
      via: 'public',
      access_identity: 'me@example.com',
    })
  })
})

describe('EA attribution', () => {
  const eaApp = () =>
    createApp({ access: ACCESS, verify: createAccessVerifier(CLOUDFLARE, jwksServer(() => [current.jwk]).fetchJwks) })
  const createPack = async (app: Hono, name: string, headers: Record<string, string>) =>
    app.request('/api/context/packs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ name, body: 'Notes' }),
    })

  it('marks user actions from loopback that carry the EA token', async () => {
    const app = eaApp()
    expect((await createPack(app, 'Spoken pack', { host: '127.0.0.1:3006', ...EA_AUTH })).status).toBe(200)
    expect((await auditEvents.latest('context.pack_created'))?.detail).toMatchObject({ via: 'ea' })
    expect((await createPack(app, 'Typed pack', { host: '127.0.0.1:3006', ...USER_AUTH })).status).toBe(200)
    expect((await auditEvents.latest('context.pack_created'))?.detail).not.toHaveProperty('via')
    const labelled = { host: 'localhost', ...USER_AUTH, 'x-seti-via': 'ea' }
    expect((await createPack(app, 'Other pack', labelled)).status).toBe(200)
    expect((await auditEvents.latest('context.pack_created'))?.detail).not.toHaveProperty('via')
  })

  it('ignores the EA header on the public host', async () => {
    const app = eaApp()
    const headers = {
      host: 'seti.example.com',
      origin: 'https://seti.example.com',
      'cf-access-jwt-assertion': await token(current),
      'x-seti-via': 'ea',
    }
    expect((await createPack(app, 'Remote pack', headers)).status).toBe(200)
    expect((await auditEvents.latest('context.pack_created'))?.detail).toMatchObject({
      via: 'public',
      access_identity: 'me@example.com',
    })
  })

  it('leaves agent events unattributed during EA requests', async () => {
    const app = new Hono()
    app.use('*', accessGuard({ access: null, verify: null }))
    app.post('/act', async (c) => {
      await audit.record({ actor: 'agent', kind: 'agent.outward', subject_type: 'task', summary: 'Pushed' })
      return c.body(null, 204)
    })
    await app.request('/act', { method: 'POST', headers: { host: 'localhost', ...EA_AUTH } })
    expect((await auditEvents.latest('agent.outward'))?.detail).toEqual({})
  })
})
