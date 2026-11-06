import { createHash, randomBytes } from 'node:crypto'
import { normalizeSetupCode } from '@seti/shared'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { AUTH_IDLE_DAYS, AUTH_MAX_DAYS, type PublicAccess } from './config.js'
import { authSettingsRows, passkeyRows, sessionRows, setupCodeRows, type SessionListRow } from './store/auth.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** Seen times are written at most this often, so polling does not write on every request. */
const SEEN_EVERY_MS = 60_000
const TOKEN_BYTES = 32
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const USER_AGENT_MAX = 300

/** Over https the cookie takes the __Host- prefix: Secure, host-only and for every path. */
const cookieName = (secure: boolean) => (secure ? '__Host-seti_session' : 'seti_session')

const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url')

export interface SessionLimits {
  idleMs: number
  maxMs: number
}

const LIMITS: SessionLimits = { idleMs: AUTH_IDLE_DAYS * DAY_MS, maxMs: AUTH_MAX_DAYS * DAY_MS }

/** Who a passkey session belongs to, as requests carry it. */
export interface SessionIdentity {
  id: string
  passkey: string | null
}

const live = (row: SessionListRow, at: Date, limits: SessionLimits) =>
  row.expires_at > at.toISOString() && Date.parse(row.last_seen_at) + limits.idleMs > at.getTime()

/** The live session the request's cookie names; an expired one is deleted on the way. */
export async function requestSession(
  c: Context,
  secure: boolean,
  at: Date = new Date(),
  limits: SessionLimits = LIMITS,
): Promise<SessionIdentity | null> {
  const token = getCookie(c, cookieName(secure)) ?? ''
  if (!TOKEN.test(token)) {
    return null
  }
  const row = await sessionRows.byTokenHash(hashToken(token))
  if (row === undefined) {
    return null
  }
  if (!live(row, at, limits)) {
    await sessionRows.delete(row.id)
    return null
  }
  if (at.getTime() - Date.parse(row.last_seen_at) >= SEEN_EVERY_MS) {
    await sessionRows.seen(row.id, at.toISOString())
  }
  return { id: row.id, passkey: row.passkey_name }
}

export interface NewSession {
  /** Null for a session no passkey started, such as a demo visitor's. */
  passkeyId: string | null
  host: string
  secure: boolean
  ip: string | null
}

/** Signs the browser in with a fresh session id, ending the one its cookie held before. */
export async function startSession(c: Context, session: NewSession, at: Date = new Date()): Promise<string> {
  const name = cookieName(session.secure)
  const previous = getCookie(c, name)
  if (previous !== undefined && TOKEN.test(previous)) {
    await sessionRows.deleteByTokenHash(hashToken(previous))
  }
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const id = randomBytes(12).toString('base64url')
  await sessionRows.insert({
    id,
    token_hash: hashToken(token),
    passkey_id: session.passkeyId,
    host: session.host,
    user_agent: (c.req.header('user-agent') ?? '').slice(0, USER_AGENT_MAX),
    ip: session.ip,
    created_at: at.toISOString(),
    last_seen_at: at.toISOString(),
    expires_at: new Date(at.getTime() + LIMITS.maxMs).toISOString(),
  })
  setCookie(c, name, token, {
    path: '/',
    httpOnly: true,
    secure: session.secure,
    sameSite: 'Lax',
    maxAge: Math.floor(LIMITS.maxMs / 1000),
  })
  return id
}

/** Ends the browser's own session and clears its cookie. */
export async function endSession(c: Context, secure: boolean): Promise<void> {
  const name = cookieName(secure)
  const token = getCookie(c, name)
  if (token !== undefined && TOKEN.test(token)) {
    await sessionRows.deleteByTokenHash(hashToken(token))
  }
  deleteCookie(c, name, { path: '/', secure })
}

export const revokeSession = async (id: string): Promise<boolean> => sessionRows.delete(id)

export async function liveSessions(at: Date = new Date(), limits: SessionLimits = LIMITS): Promise<SessionListRow[]> {
  const idleSince = new Date(at.getTime() - limits.idleMs).toISOString()
  await sessionRows.prune(at.toISOString(), idleSince)
  return sessionRows.list(at.toISOString(), idleSince)
}

/** Tells a fresh install with a public host but no passkey for it how to enroll the first one. */
export async function signInHint(access: PublicAccess | null): Promise<void> {
  if (access === null || (await passkeyRows.countFor(access.hostname)) > 0) {
    return
  }
  const gate = access.cloudflare === null ? 'only a passkey opens it' : 'Cloudflare Access guards it meanwhile'
  process.stdout.write(
    `auth: ${access.hostname} has no passkey yet and ${gate}; run pnpm setup-code on this host to add one\n`,
  )
}

let enforcedCache: boolean | null = null

/** Whether the public host needs Seti's own sign-in even when Cloudflare Access let a request in. */
export async function authEnforced(): Promise<boolean> {
  enforcedCache ??= (await authSettingsRows.get(new Date().toISOString())).enforced
  return enforcedCache
}

export async function storeEnforced(enforced: boolean): Promise<void> {
  await authSettingsRows.get(new Date().toISOString())
  await authSettingsRows.setEnforced(enforced, new Date().toISOString())
  enforcedCache = enforced
}

const SETUP_CODE_MS = 15 * 60_000
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 26 base32 characters carry 130 random bits. */
const SETUP_CODE_CHARS = 26

/** A one-time code that lets a browser enroll a passkey without being signed in, for 15 minutes. */
export async function createSetupCode(at: Date = new Date()): Promise<{ code: string; expires_at: string }> {
  const bytes = randomBytes(SETUP_CODE_CHARS)
  const raw = Array.from(bytes, (byte) => CROCKFORD[byte % CROCKFORD.length] ?? '0').join('')
  const expires = new Date(at.getTime() + SETUP_CODE_MS).toISOString()
  await setupCodeRows.insert(hashToken(raw), at.toISOString(), expires)
  const code = raw.match(/.{1,5}/g)?.join('-') ?? raw
  return { code, expires_at: expires }
}

export const setupCodeHash = (code: string) => hashToken(normalizeSetupCode(code))

export const setupCodeValid = async (code: string, at: Date = new Date()) =>
  setupCodeRows.valid(setupCodeHash(code), at.toISOString())

export const consumeSetupCode = async (hash: string, at: Date = new Date()) =>
  setupCodeRows.consume(hash, at.toISOString())
