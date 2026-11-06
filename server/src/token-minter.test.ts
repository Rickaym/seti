import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { connectionInput, mintSettingsInput, type NamedSecretName } from '@seti/shared'
import { decodeProtectedHeader, jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'
import { createTokenMinter, MintError, type Minter, type MinterDeps } from './token-minter.js'

const TOKEN_URL = 'https://login.example.test/tenant/oauth2/v2.0/token'
const CLIENT_SECRET = ['client', 'secret', 'value', '42'].join('-')
const REFRESH = ['refresh', 'one'].join('-')
const NOW = new Date('2026-09-30T12:00:00Z')

interface Call {
  url: string
  form: URLSearchParams
  authorization: string | null
}

interface Answer {
  status?: number
  body: Record<string, unknown>
}

/** A token endpoint that records each call and answers from a script. */
function fakeEndpoint(answer: (call: Call, index: number) => Answer | Promise<Answer>) {
  const calls: Call[] = []
  const fetch: MinterDeps['fetch'] = async (input, init) => {
    const headers = new Headers(init?.headers)
    const call: Call = {
      url: input instanceof Request ? input.url : String(input),
      form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      authorization: headers.get('authorization'),
    }
    calls.push(call)
    const { status = 200, body } = await answer(call, calls.length - 1)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetch }
}

const bare = (name: string) => name.replace(/^named:/, '')

function setup(answer: Parameters<typeof fakeEndpoint>[0], secrets: Record<string, string> = {}) {
  const endpoint = fakeEndpoint(answer)
  const store = new Map(Object.entries(secrets))
  const recorded: { ruleId: string; error: string | null }[] = []
  let clock = NOW.getTime()
  const minter = createTokenMinter({
    fetch: endpoint.fetch,
    secret: async (name) => Promise.resolve(store.get(bare(name)) ?? null),
    rotate: async (name, expected, next) => {
      if (store.get(bare(name)) !== expected) {
        return Promise.resolve(false)
      }
      store.set(bare(name), next)
      return Promise.resolve(true)
    },
    record: async (ruleId, error) => {
      recorded.push({ ruleId, error })
      return Promise.resolve()
    },
    now: () => clock,
  })
  return {
    minter,
    calls: endpoint.calls,
    store,
    recorded,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

type SecretField = 'client_id_secret' | 'client_secret' | 'private_key' | 'refresh_token' | 'service_account'

type MinterInput = Record<string, unknown> & { grant: Minter['grant'] } & Partial<Record<SecretField, string>>

/** A minter whose secrets are named secrets of the test store, by their bare names. */
function minterOf(input: MinterInput): Minter {
  const named = (field: SecretField): NamedSecretName | null => {
    const name = input[field]
    return name === undefined ? null : `named:${name}`
  }
  return {
    ...mintSettingsInput.parse(input),
    grant: input.grant,
    client_id_secret: named('client_id_secret'),
    client_secret: named('client_secret'),
    private_key: named('private_key'),
    refresh_token: named('refresh_token'),
    service_account: named('service_account'),
  }
}

const clientCredentials = minterOf({
  grant: 'client_credentials',
  token_url: TOKEN_URL,
  client_id: 'app-id',
  client_secret: 'graph_secret',
  scope: 'https://graph.microsoft.com/.default',
})

const bearer = (token: string, expires = 3600) => ({
  body: { access_token: token, token_type: 'Bearer', expires_in: expires, scope: 'Mail.Read' },
})

describe('the client_credentials grant', () => {
  it('posts the client secret, caches the token and mints again shortly before it expires', async () => {
    const t = setup((_call, i) => bearer(`token-${String(i)}`), { graph_secret: CLIENT_SECRET })
    const first = await t.minter.token('rule-1', clientCredentials)
    expect(first).toMatchObject({ token: 'token-0', tokenType: 'Bearer', scope: 'Mail.Read' })
    expect(t.calls[0]?.url).toBe(TOKEN_URL)
    expect(Object.fromEntries(t.calls[0]?.form ?? [])).toEqual({
      grant_type: 'client_credentials',
      client_id: 'app-id',
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    })
    t.advance(50 * 60_000)
    expect((await t.minter.token('rule-1', clientCredentials)).token).toBe('token-0')
    t.advance(6 * 60_000)
    expect((await t.minter.token('rule-1', clientCredentials)).token).toBe('token-1')
    expect(t.calls).toHaveLength(2)
    expect(t.recorded.map((r) => r.error)).toEqual([null, null])
  })

  it('refreshes short-lived tokens a tenth of their life early', async () => {
    const t = setup((_call, i) => bearer(`short-${String(i)}`, 100), { graph_secret: CLIENT_SECRET })
    await t.minter.token('rule-1', clientCredentials)
    t.advance(89_000)
    expect((await t.minter.token('rule-1', clientCredentials)).token).toBe('short-0')
    t.advance(2000)
    expect((await t.minter.token('rule-1', clientCredentials)).token).toBe('short-1')
  })

  it('runs one mint for callers that ask at once', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const t = setup(
      async () => {
        await gate
        return bearer('shared')
      },
      { graph_secret: CLIENT_SECRET },
    )
    const waiting = Array.from({ length: 10 }, async () => t.minter.token('rule-1', clientCredentials))
    release()
    const tokens = await Promise.all(waiting)
    expect(new Set(tokens.map((token) => token.token))).toEqual(new Set(['shared']))
    expect(t.calls).toHaveLength(1)
  })

  it('sends client_secret_basic as an Authorization header', async () => {
    const t = setup(() => bearer('basic'), { graph_secret: CLIENT_SECRET })
    await t.minter.token('rule-1', { ...clientCredentials, client_auth: 'client_secret_basic' })
    const encoded = Buffer.from(`app-id:${CLIENT_SECRET}`).toString('base64')
    expect(t.calls[0]?.authorization).toBe(`Basic ${encoded}`)
    expect(t.calls[0]?.form.has('client_secret')).toBe(false)
  })

  it('signs a private_key_jwt client assertion with the key and certificate thumbprint', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const thumbprint = randomBytes(20).toString('hex').toUpperCase()
    const t = setup(() => bearer('cert'), { entra_key: pem, app_id_secret: 'hidden-app-id' })
    const minter = minterOf({
      grant: 'client_credentials',
      token_url: TOKEN_URL,
      client_id_secret: 'app_id_secret',
      client_auth: 'private_key_jwt',
      private_key: 'entra_key',
      certificate_thumbprint: thumbprint,
      scope: 'https://graph.microsoft.com/.default',
    })
    await t.minter.token('rule-1', minter)
    const form = t.calls[0]?.form ?? new URLSearchParams()
    expect(form.get('client_id')).toBe('hidden-app-id')
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
    const assertion = form.get('client_assertion') ?? ''
    const { payload } = await jwtVerify(assertion, publicKey, { audience: TOKEN_URL, currentDate: NOW })
    expect(payload).toMatchObject({ iss: 'hidden-app-id', sub: 'hidden-app-id' })
    expect(decodeProtectedHeader(assertion)).toMatchObject({
      alg: 'RS256',
      x5t: Buffer.from(thumbprint, 'hex').toString('base64url'),
    })
  })
})

describe('the refresh_token grant', () => {
  const refresh = minterOf({
    grant: 'refresh_token',
    token_url: TOKEN_URL,
    client_id: 'public-app',
    client_auth: 'none',
    refresh_token: 'mail_refresh',
  })

  it('stores a rotated refresh token and mints the next token with it', async () => {
    const t = setup(
      (call, i) => ({
        body: {
          access_token: `access-${String(i)}`,
          expires_in: 600,
          refresh_token: `${call.form.get('refresh_token') ?? ''}-next`,
        },
      }),
      { mail_refresh: REFRESH },
    )
    expect((await t.minter.token('rule-r', refresh)).token).toBe('access-0')
    expect(t.calls[0]?.form.get('refresh_token')).toBe(REFRESH)
    expect(t.store.get('mail_refresh')).toBe(`${REFRESH}-next`)
    const second = await t.minter.test('rule-r', refresh)
    expect(second.token).toBe('access-1')
    expect(t.calls[1]?.form.get('refresh_token')).toBe(`${REFRESH}-next`)
    expect(t.store.get('mail_refresh')).toBe(`${REFRESH}-next-next`)
  })

  it('leaves a refresh token alone that another writer replaced first', async () => {
    const store: { current: Map<string, string> | null } = { current: null }
    const t = setup(
      () => {
        store.current?.set('mail_refresh', 'changed-meanwhile')
        return { body: { access_token: 'a', refresh_token: 'ours-too-late' } }
      },
      { mail_refresh: REFRESH },
    )
    store.current = t.store
    await t.minter.token('rule-r', refresh)
    expect(t.store.get('mail_refresh')).toBe('changed-meanwhile')
  })
})

describe('the jwt_bearer grant', () => {
  it('signs a Google service account assertion and exchanges it', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const key = {
      type: 'service_account',
      client_email: 'reader@project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      private_key_id: 'key-7',
      token_uri: 'https://oauth2.googleapis.com/token',
    }
    const t = setup(() => bearer('ya29.google'), { google_sa: JSON.stringify(key) })
    const minter = minterOf({
      grant: 'jwt_bearer',
      token_url: 'https://oauth2.googleapis.com/token',
      service_account: 'google_sa',
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      subject: 'user@example.com',
    })
    expect((await t.minter.token('rule-g', minter)).token).toBe('ya29.google')
    const form = t.calls[0]?.form ?? new URLSearchParams()
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const assertion = form.get('assertion') ?? ''
    const { payload, protectedHeader } = await jwtVerify(assertion, publicKey, {
      audience: 'https://oauth2.googleapis.com/token',
      issuer: key.client_email,
      currentDate: NOW,
    })
    expect(payload).toMatchObject({ scope: 'https://www.googleapis.com/auth/drive.readonly', sub: 'user@example.com' })
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(3600)
    expect(protectedHeader).toMatchObject({ alg: 'RS256', kid: 'key-7' })
    expect(form.has('client_secret')).toBe(false)
  })

  it('signs an RFC 7523 assertion with its own issuer and key, and asks for the scope in the form', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const t = setup(() => bearer('sf-token'), { sf_key: pem })
    const minter = minterOf({
      grant: 'jwt_bearer',
      token_url: 'https://login.example.test/services/oauth2/token',
      issuer: 'connected-app-id',
      subject: 'integration@example.com',
      audience: 'https://login.example.test',
      key_id: 'k1',
      scope: 'api',
      private_key: 'sf_key',
    })
    expect((await t.minter.token('rule-s', minter)).token).toBe('sf-token')
    const form = t.calls[0]?.form ?? new URLSearchParams()
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(form.get('scope')).toBe('api')
    const { payload, protectedHeader } = await jwtVerify(form.get('assertion') ?? '', publicKey, {
      audience: 'https://login.example.test',
      issuer: 'connected-app-id',
      currentDate: NOW,
    })
    expect(payload).toMatchObject({ sub: 'integration@example.com' })
    expect(payload).not.toHaveProperty('scope')
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300)
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'k1' })
    expect(JSON.stringify(t.recorded)).not.toContain('PRIVATE KEY')
  })

  it('says a private key that is not PEM is unusable, without the key', async () => {
    const t = setup(() => bearer('never'), { sf_key: 'not-a-key-but-secret-text' })
    const minter = minterOf({
      grant: 'jwt_bearer',
      token_url: TOKEN_URL,
      issuer: 'app',
      private_key: 'sf_key',
    })
    await expect(t.minter.token('rule-s', minter)).rejects.toThrow('The private key is not a PEM private key')
    expect(t.calls).toHaveLength(0)
    expect(JSON.stringify(t.recorded)).not.toContain('not-a-key-but-secret-text')
  })
})

describe('renewal and failures', () => {
  it('mints afresh after an upstream refused the cached token, and reuses a newer one', async () => {
    const t = setup((_call, i) => bearer(`token-${String(i)}`), { graph_secret: CLIENT_SECRET })
    await t.minter.token('rule-1', clientCredentials)
    expect((await t.minter.renew('rule-1', clientCredentials, 'token-0')).token).toBe('token-1')
    expect((await t.minter.renew('rule-1', clientCredentials, 'token-0')).token).toBe('token-1')
    expect(t.calls).toHaveLength(2)
  })

  it('records why a mint failed without the secrets the endpoint echoed', async () => {
    const t = setup(
      (call) => ({
        status: 401,
        body: { error: 'invalid_client', error_description: `secret ${call.form.get('client_secret') ?? ''} is wrong` },
      }),
      { graph_secret: CLIENT_SECRET },
    )
    const error = await t.minter.token('rule-1', clientCredentials).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MintError)
    expect((error as Error).message).toBe(
      'the token endpoint answered 401 (invalid_client: secret [redacted] is wrong)',
    )
    expect(t.recorded).toEqual([{ ruleId: 'rule-1', error: (error as Error).message }])
    expect(JSON.stringify(t.recorded)).not.toContain(CLIENT_SECRET)
  })

  it('names a missing secret and a token that cannot go in a header', async () => {
    const missing = setup(() => bearer('x'))
    await expect(missing.minter.token('rule-1', clientCredentials)).rejects.toThrow('The client secret is not set')
    const broken = setup(() => bearer('two\nlines'), { graph_secret: CLIENT_SECRET })
    await expect(broken.minter.token('rule-1', clientCredentials)).rejects.toThrow('cannot go in a header')
  })

  it('refuses connection settings that miss what their kind needs', () => {
    const mint = { token_url: TOKEN_URL, client_id: 'app' }
    const base = { name: 'graph', env: 'GRAPH_TOKEN', hosts: ['graph.example.test'] }
    const valid = (input: Record<string, unknown>) => connectionInput.safeParse({ ...base, ...input }).success
    expect(valid({ kind: 'client_credentials', mint })).toBe(true)
    expect(valid({ kind: 'client_credentials', mint: { ...mint, client_auth: 'none' } })).toBe(false)
    expect(valid({ kind: 'client_credentials', mint: null })).toBe(false)
    expect(valid({ kind: 'key', mint })).toBe(false)
    expect(valid({ kind: 'jwt_bearer', mint: { ...mint, token_url: 'http://plain.test/token' } })).toBe(false)
    expect(valid({ kind: 'refresh_token', mint: { ...mint, extra_params: { grant_type: 'password' } } })).toBe(false)
  })
})
