import { createHash, randomUUID, type KeyObject } from 'node:crypto'
import type { MintSettings, StoredSecretName } from '@seti/shared'
import { SignJWT } from 'jose'
import { algorithmOf, KeyError, privateKey, serviceAccount, x5t } from './jwt-keys.js'

/** A connection's mint settings with the stored secret behind each slot it has set. */
export interface Minter extends MintSettings {
  grant: 'client_credentials' | 'refresh_token' | 'jwt_bearer'
  client_id_secret: StoredSecretName | null
  client_secret: StoredSecretName | null
  private_key: StoredSecretName | null
  refresh_token: StoredSecretName | null
  /** A Google service account key file (JSON) for the jwt_bearer grant. */
  service_account: StoredSecretName | null
}

/** A short-lived token a connection mints; it never leaves the server and the proxy. */
export interface MintedToken {
  token: string
  tokenType: string | null
  scope: string | null
  mintedAt: number
  expiresAt: number
}

/** A mint that failed; the message names the reason and never a secret or token. */
export class MintError extends Error {}

export interface MinterDeps {
  fetch: typeof fetch
  /** A stored secret's value, or null when it is not set. */
  secret: (name: StoredSecretName) => Promise<string | null>
  /** Stores a rotated refresh token while the old one is still in place. */
  rotate: (name: StoredSecretName, expected: string, next: string) => Promise<boolean>
  /** Keeps the outcome of the latest mint on the connection: null after a success. */
  record: (connectionId: string, error: string | null) => Promise<void>
  now: () => number
}

const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const CLIENT_ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const ASSERTION_SECONDS = 300
const GOOGLE_ASSERTION_SECONDS = 3600
const UNKNOWN_LIFETIME_MS = 5 * 60_000
const MAX_MARGIN_MS = 5 * 60_000
const MINT_TIMEOUT_MS = 15_000
const ERROR_MAX = 300
const HEADER_SAFE = /^[\x21-\x7E]+$/

/** How early a token is replaced: a tenth of its life, at most five minutes. */
const marginOf = (token: MintedToken) => Math.min(MAX_MARGIN_MS, (token.expiresAt - token.mintedAt) / 10)

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

/** Replaces each known secret in a message, so a provider echoing one cannot leak it. */
function redact(message: string, secrets: readonly string[]): string {
  const cleaned = secrets
    .filter((value) => value.length >= 6)
    .reduce((out, value) => out.split(value).join('[redacted]'), message)
  return cleaned.length > ERROR_MAX ? `${cleaned.slice(0, ERROR_MAX)}...` : cleaned
}

/** What one mint sends: the form, any Basic authorization, and every secret it used. */
interface MintRequest {
  form: URLSearchParams
  authorization: string | null
  used: string[]
  refreshToken: { name: StoredSecretName; value: string } | null
}

class Builder {
  private readonly used: string[] = []
  private readonly minter: Minter
  private readonly deps: MinterDeps

  constructor(minter: Minter, deps: MinterDeps) {
    this.minter = minter
    this.deps = deps
  }

  async secret(name: StoredSecretName | null, what: string): Promise<string> {
    let value: string | null
    try {
      value = name === null ? null : await this.deps.secret(name)
    } catch {
      throw new MintError(`The ${what} cannot be opened`)
    }
    if (value === null) {
      throw new MintError(`The ${what} is not set`)
    }
    const trimmed = value.trim()
    this.used.push(trimmed)
    return trimmed
  }

  async clientId(): Promise<string> {
    const { minter } = this
    if (minter.client_id_secret !== null) {
      return this.secret(minter.client_id_secret, 'client id')
    }
    if (minter.client_id === null) {
      throw new MintError('The connection has no client id')
    }
    return minter.client_id
  }

  private async sign(key: KeyObject, claims: Json, header: Json): Promise<string> {
    const alg = algorithmOf(key)
    const now = Math.floor(this.deps.now() / 1000)
    const jwt = await new SignJWT(claims)
      .setProtectedHeader({ ...header, alg, typ: 'JWT' })
      .setIssuedAt(now)
      .sign(key)
    this.used.push(jwt)
    return jwt
  }

  private async clientAssertion(clientId: string): Promise<string> {
    const { minter } = this
    const key = privateKey(await this.secret(minter.private_key, 'private key'))
    const now = Math.floor(this.deps.now() / 1000)
    const header: Json = {
      ...(minter.key_id === null ? {} : { kid: minter.key_id }),
      ...(minter.certificate_thumbprint === null ? {} : { x5t: x5t(minter.certificate_thumbprint) }),
    }
    const claims = {
      iss: clientId,
      sub: clientId,
      aud: minter.token_url,
      jti: randomUUID(),
      nbf: now,
      exp: now + ASSERTION_SECONDS,
    }
    return this.sign(key, claims, header)
  }

  /** An RFC 7523 assertion signed with the connection's own private key and issuer. */
  private async signedAssertion(issuer: string): Promise<string> {
    const { minter } = this
    const key = privateKey(await this.secret(minter.private_key, 'private key'))
    const now = Math.floor(this.deps.now() / 1000)
    const claims = {
      iss: issuer,
      sub: minter.subject ?? issuer,
      aud: minter.audience ?? minter.token_url,
      jti: randomUUID(),
      nbf: now,
      exp: now + ASSERTION_SECONDS,
    }
    return this.sign(key, claims, minter.key_id === null ? {} : { kid: minter.key_id })
  }

  private async googleAssertion(): Promise<string> {
    const { minter } = this
    const account = serviceAccount(await this.secret(minter.service_account, 'key file'))
    this.used.push(account.privateKey)
    const now = Math.floor(this.deps.now() / 1000)
    const claims: Json = {
      iss: account.clientEmail,
      aud: minter.audience ?? minter.token_url,
      exp: now + GOOGLE_ASSERTION_SECONDS,
      ...(minter.scope === null ? {} : { scope: minter.scope }),
      ...(minter.subject === null ? {} : { sub: minter.subject }),
    }
    return this.sign(privateKey(account.privateKey), claims, account.keyId === null ? {} : { kid: account.keyId })
  }

  /** The assertion grant: a Google key file's own, or one signed with the connection's key. */
  private async bearerForm(form: URLSearchParams): Promise<void> {
    const { minter } = this
    form.set('grant_type', JWT_BEARER)
    const issuer = minter.issuer ?? null
    form.set('assertion', issuer === null ? await this.googleAssertion() : await this.signedAssertion(issuer))
    if (issuer !== null && minter.scope !== null) {
      form.set('scope', minter.scope)
    }
  }

  /** The client grants: the refresh token if any, client authentication and the scope. */
  private async clientForm(form: URLSearchParams): Promise<Pick<MintRequest, 'authorization' | 'refreshToken'>> {
    const { minter } = this
    form.set('grant_type', minter.grant)
    let refreshToken: MintRequest['refreshToken'] = null
    if (minter.grant === 'refresh_token') {
      const name = minter.refresh_token
      const value = await this.secret(name, 'refresh token')
      form.set('refresh_token', value)
      refreshToken = name === null ? null : { name, value }
    }
    const authorization = await this.clientAuth(form)
    if (minter.scope !== null) {
      form.set('scope', minter.scope)
    }
    return { authorization, refreshToken }
  }

  async build(): Promise<MintRequest> {
    const { minter } = this
    const form = new URLSearchParams()
    let client: Pick<MintRequest, 'authorization' | 'refreshToken'> = { authorization: null, refreshToken: null }
    if (minter.grant === 'jwt_bearer') {
      await this.bearerForm(form)
    } else {
      client = await this.clientForm(form)
    }
    if (minter.grant !== 'jwt_bearer' && minter.audience !== null) {
      form.set('audience', minter.audience)
    }
    if (minter.resource !== null) {
      form.set('resource', minter.resource)
    }
    for (const [key, value] of Object.entries(minter.extra_params)) {
      form.set(key, value)
    }
    return { form, ...client, used: this.used }
  }

  private async clientAuth(form: URLSearchParams): Promise<string | null> {
    const { minter } = this
    const clientId = await this.clientId()
    switch (minter.client_auth) {
      case 'client_secret_basic': {
        const secret = await this.secret(minter.client_secret, 'client secret')
        const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`
        return `Basic ${Buffer.from(pair).toString('base64')}`
      }
      case 'client_secret_post':
        form.set('client_id', clientId)
        form.set('client_secret', await this.secret(minter.client_secret, 'client secret'))
        return null
      case 'private_key_jwt':
        form.set('client_id', clientId)
        form.set('client_assertion_type', CLIENT_ASSERTION)
        form.set('client_assertion', await this.clientAssertion(clientId))
        return null
      case 'none':
        form.set('client_id', clientId)
        return null
    }
  }
}

async function readError(res: Response, used: readonly string[]): Promise<MintError> {
  const body: unknown = await res.json().catch(() => null)
  const code = isObject(body) ? text(body.error) : null
  const description = isObject(body) ? text(body.error_description) : null
  const detail = [code, description].filter((part) => part !== null).join(': ')
  const said = detail === '' ? '' : ` (${detail})`
  const reason = `the token endpoint answered ${String(res.status)}${said}`
  return new MintError(redact(reason, used))
}

const minterKey = (connectionId: string, minter: Minter) =>
  `${connectionId}:${createHash('sha256').update(JSON.stringify(minter)).digest('hex').slice(0, 16)}`

/**
 * Mints short-lived tokens for OAuth connections and caches each until shortly before it
 * expires. One mint runs per connection at a time; callers waiting on it share its result.
 */
export function createTokenMinter(deps: MinterDeps) {
  const cache = new Map<string, MintedToken>()
  const inflight = new Map<string, Promise<MintedToken>>()

  const mintOnce = async (minter: Minter): Promise<MintedToken> => {
    const request = await new Builder(minter, deps).build().catch((e: unknown) => {
      throw e instanceof KeyError ? new MintError(e.message) : e
    })
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...(request.authorization === null ? {} : { authorization: request.authorization }),
    }
    let res: Response
    try {
      res = await deps.fetch(minter.token_url, {
        method: 'POST',
        headers,
        body: request.form.toString(),
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      throw new MintError(redact(`the token endpoint could not be reached: ${reason}`, request.used))
    }
    if (!res.ok) {
      throw await readError(res, request.used)
    }
    const body: unknown = await res.json().catch(() => null)
    const token = isObject(body) ? text(body.access_token) : null
    if (!isObject(body) || token === null) {
      throw new MintError('the token endpoint answered without an access_token')
    }
    if (!HEADER_SAFE.test(token)) {
      throw new MintError('the token endpoint answered with a token that cannot go in a header')
    }
    const rotated = text(body.refresh_token)
    if (request.refreshToken !== null && rotated !== null && rotated !== request.refreshToken.value) {
      await deps.rotate(request.refreshToken.name, request.refreshToken.value, rotated)
    }
    const mintedAt = deps.now()
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in)
    const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : UNKNOWN_LIFETIME_MS
    return {
      token,
      tokenType: text(body.token_type),
      scope: text(body.scope),
      mintedAt,
      expiresAt: mintedAt + lifetime,
    }
  }

  const mint = async (connectionId: string, minter: Minter): Promise<MintedToken> => {
    const key = minterKey(connectionId, minter)
    const running = inflight.get(key)
    if (running !== undefined) {
      return running
    }
    const next = mintOnce(minter).then(
      async (token) => {
        cache.set(key, token)
        await deps.record(connectionId, null).catch(() => undefined)
        return token
      },
      async (e: unknown) => {
        cache.delete(key)
        const reason = e instanceof MintError ? e.message : 'the mint failed'
        await deps.record(connectionId, reason).catch(() => undefined)
        throw e instanceof MintError ? e : new MintError(reason)
      },
    )
    inflight.set(key, next)
    void next.catch(() => undefined).finally(() => inflight.delete(key))
    return next
  }

  return {
    /** A token for the connection, from the cache while it is fresh. */
    token: async (connectionId: string, minter: Minter): Promise<MintedToken> => {
      const cached = cache.get(minterKey(connectionId, minter))
      if (cached !== undefined && cached.expiresAt - marginOf(cached) > deps.now()) {
        return cached
      }
      return mint(connectionId, minter)
    },
    /** A fresh token after an upstream refused `refused`; a newer cached one is reused. */
    renew: async (connectionId: string, minter: Minter, refused: string): Promise<MintedToken> => {
      const key = minterKey(connectionId, minter)
      const cached = cache.get(key)
      if (cached !== undefined && cached.token !== refused) {
        return cached
      }
      cache.delete(key)
      return mint(connectionId, minter)
    },
    /** Mints once, bypassing the cache, for the Test button. */
    test: async (connectionId: string, minter: Minter): Promise<MintedToken> => {
      cache.delete(minterKey(connectionId, minter))
      return mint(connectionId, minter)
    },
  }
}
