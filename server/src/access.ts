import { AsyncLocalStorage } from 'node:async_hooks'
import {
  ASSET_LINKS_PATH,
  DEVICE_PAIR_PATH,
  HOOKS_PREFIX,
  PAIR_PAGE_PATH,
  SETI_HOSTNAMES,
  type DeviceScope,
  type ModCaller,
  type ModCapabilityName,
  type ModGrantScopes,
  type Task,
} from '@seti/shared'
import type { Context, MiddlewareHandler, Next } from 'hono'
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type FetchImplementation } from 'jose'
import type { CloudflareAccess, PublicAccess } from './config.js'
import { isDeviceProof, ProofFailure, verifyDeviceProof, type DeviceIdentity } from './devices.js'
import { fail } from './http.js'
import { defaultLocalAuth, type LocalAuth } from './local-auth.js'
import { authEnforced, requestSession } from './seti-auth.js'
import { isPublicShareRequest, redactSharePath } from './share-path.js'

const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion'

const CLOCK_SKEW_S = 30
const JWKS_COOLDOWN_MS = 30_000
const JWKS_MAX_AGE_MS = 10 * 60_000
const JWKS_TIMEOUT_MS = 5_000

/** Who Access let through: the user's email, or the common name of a service token. */
type AccessIdentity = string | null

export type AccessVerifier = (token: string) => Promise<AccessIdentity>

/** Verifies an Access JWT: RS256 against the team JWKS, audience, issuer, exp and nbf. */
export function createAccessVerifier(access: CloudflareAccess, fetchJwks?: FetchImplementation): AccessVerifier {
  const issuer = `https://${access.team}`
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    cooldownDuration: JWKS_COOLDOWN_MS,
    cacheMaxAge: JWKS_MAX_AGE_MS,
    timeoutDuration: JWKS_TIMEOUT_MS,
    ...(fetchJwks === undefined ? {} : { [customFetch]: fetchJwks }),
  })
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: access.aud,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_SKEW_S,
      requiredClaims: ['exp'],
    })
    const identity = payload.email ?? payload.common_name
    return typeof identity === 'string' ? identity : null
  }
}

/** A request that arrived on the public hostname with a verified Access token. */
interface PublicRequest {
  via: 'public'
  identity: AccessIdentity
}

/** A browser signed in with a passkey, on the public host or on loopback. */
interface SessionRequest {
  via: 'session'
  sessionId: string
  /** The name of the passkey that signed the session in; null once that passkey is gone. */
  passkey: string | null
}

/** A loopback request the EA voice bot made on the user's behalf, with the EA's token. */
interface EaRequest {
  via: 'ea'
}

/** A loopback request with the user's local token or session cookie. */
interface LocalRequest {
  via: 'local'
}

/** An agent calling one of its seti tools, inside Seti's own process. */
interface AgentRequest {
  via: 'agent'
  taskId: string
  title: string
  /** Full acts on Seti as the EA does; self reaches only the agent's own task. */
  scope: 'self' | 'full'
}

/** A mod calling Seti through the mod API: a bundled mod's server code, or third-party logic. */
interface ModSource {
  via: 'mod'
  modId: string
  /** The capabilities the mod was granted; every call is checked against them. */
  grants: readonly ModCapabilityName[]
  /** The granted scope of each capability, read from mod_grant, never from the mod. */
  scopes: ModGrantScopes
  /** The event the call belongs to, for per-event counters; null outside an event. */
  eventId: string | null
  /** Who started the event; informational only, since grants never depend on it. */
  caller: ModCaller | null
}

/** What Seti knows of a mod when it runs a call as the mod; the mod supplies none of it. */
interface ModRun {
  id: string
  grants: readonly ModCapabilityName[]
  scopes?: ModGrantScopes
  eventId?: string
  caller?: ModCaller
}

/** A paired device, proven by its key; it reaches only the routes of its scopes. */
interface DeviceRequest {
  via: 'device'
  deviceId: string
  name: string
  scopes: DeviceScope[]
  /** Its widgets show agent titles. */
  showNames: boolean
}

/** Who an authenticated request came from; null for requests without a credential. */
type RequestSource =
  PublicRequest | SessionRequest | EaRequest | LocalRequest | AgentRequest | DeviceRequest | ModSource

const requestSources = new AsyncLocalStorage<RequestSource>()

export const currentRequestSource = (): RequestSource | null => requestSources.getStore() ?? null

/** Set for the whole of every HTTP request, whether or not it carries a credential. */
const requests = new AsyncLocalStorage<true>()

/** Inside an HTTP request that carries no credential, such as a sign-in attempt. */
export const anonymousRequest = (): boolean => requests.getStore() === true && currentRequestSource() === null

/** Runs work that outlives the request, such as an agent's session, as no request's. */
export const outsideRequest = <T>(fn: () => T): T => requests.exit(() => requestSources.exit(fn))

/**
 * Runs a seti tool as the agent that called it, so what it changes is audited as that agent and
 * reaches no further than its Seti control level.
 */
export const asAgent = async <T>(
  agent: Pick<Task, 'id' | 'title' | 'seti_control'>,
  fn: () => Promise<T>,
): Promise<T> =>
  requestSources.run(
    { via: 'agent', taskId: agent.id, title: agent.title, scope: agent.seti_control === 'full' ? 'full' : 'self' },
    fn,
  )

/**
 * Runs a mod's call into Seti as the mod, so what it changes is audited as `mod:<id>` and reaches
 * no further than its grants; a user's request to the mod's route stays the user's until then.
 */
export const asMod = async <T>(mod: ModRun, fn: () => Promise<T>) =>
  requestSources.run(
    {
      via: 'mod',
      modId: mod.id,
      grants: mod.grants,
      scopes: mod.scopes ?? {},
      eventId: mod.eventId ?? null,
      caller: mod.caller ?? null,
    },
    fn,
  )

/** Who asked a mod's command to run, kept while the command runs as the mod. */
const askers = new AsyncLocalStorage<RequestSource | null>()

/** Runs a mod's command handler, remembering who asked it, so `asAsker` can act as them. */
export const forAsker = <T>(fn: () => T): T => askers.run(currentRequestSource(), fn)

/**
 * Runs core work a mod hands Seti as whoever asked the mod: the caller of its command, or, in a
 * route, the request itself. Only bundled-only services that act for the asker use it.
 */
export const asAsker = async <T>(fn: () => Promise<T>): Promise<T> => {
  const asker = askers.getStore()
  if (asker === undefined) {
    return fn()
  }
  return asker === null ? outsideRequest(fn) : requestSources.run(asker, fn)
}

/** The public host a request arrived on, whether or not it carries a credential. */
interface PublicHost {
  hostname: string
  origin: string
}

const publicHosts = new AsyncLocalStorage<PublicHost>()

/** The public host of the current request; null for loopback requests. */
export const currentPublicHost = (): PublicHost | null => publicHosts.getStore() ?? null

/** The page that sent the request is Seti's own: its public origin, else a loopback host. */
export function isSameOrigin(origin: string): boolean {
  const publicHost = currentPublicHost()
  if (publicHost !== null) {
    return origin === publicHost.origin
  }
  return URL.canParse(origin) && SETI_HOSTNAMES.has(new URL(origin).hostname)
}

/**
 * Paths callers reach before they have a credential, each checking its own: the sign-in page's
 * calls, device pairing with its code, the pairing landing page and the Android asset links.
 */
const OPEN_PATHS: ReadonlySet<string> = new Set([
  '/api/auth',
  '/api/auth/signin/options',
  '/api/auth/signin',
  '/api/auth/setup/options',
  '/api/auth/setup',
  DEVICE_PAIR_PATH,
  PAIR_PAGE_PATH,
  ASSET_LINKS_PATH,
])

export const isOpenPath = (path: string) => OPEN_PATHS.has(path)

/** Cloudflare adds cf-* headers to everything it proxies; a local browser request never has them. */
function viaCloudflare(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (name.startsWith('cf-')) {
      return true
    }
  }
  return (headers.get('cdn-loop') ?? '').toLowerCase().includes('cloudflare')
}

function reason(e: unknown): string {
  if (e instanceof errors.JOSEError) {
    return e.code
  }
  return e instanceof Error ? e.name : 'unknown'
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const loggedPath = (c: Context) => redactSharePath(c.req.path)

const allowedIdentity = (access: CloudflareAccess, identity: AccessIdentity) =>
  access.allowed === null || (identity !== null && access.allowed.has(identity.toLowerCase()))

/** Runs a request on the public host as `source`, and logs it when it writes. */
async function servePublic(c: Context, next: Next, source: PublicRequest | SessionRequest, who: string) {
  await requestSources.run(source, next)
  if (!READ_METHODS.has(c.req.method)) {
    process.stdout.write(`access: ${c.req.method} ${loggedPath(c)} ${String(c.res.status)} by ${who}\n`)
  }
  return undefined
}

async function serveAccess(c: Context, next: Next, access: CloudflareAccess, verify: AccessVerifier) {
  const token = c.req.header(ACCESS_JWT_HEADER) ?? ''
  if (token === '') {
    return fail(c, 403, 'Forbidden', 'Missing Cloudflare Access token')
  }
  let identity: AccessIdentity
  try {
    identity = await verify(token)
  } catch (e) {
    process.stderr.write(`access: rejected ${c.req.method} ${loggedPath(c)}: ${reason(e)}\n`)
    return fail(c, 403, 'Forbidden', 'Invalid Cloudflare Access token')
  }
  if (!allowedIdentity(access, identity)) {
    process.stderr.write(`access: refused ${c.req.method} ${loggedPath(c)} for ${identity ?? 'no identity'}\n`)
    return fail(c, 403, 'Forbidden', 'This Access identity is not allowed on this Seti')
  }
  return servePublic(c, next, { via: 'public', identity }, identity ?? 'unknown')
}

/** A paired device's request, proven by its key; a refused proof never falls back to anything. */
type ProofRefused = (c: Context, reason: string) => Promise<void>

let proofRefused: ProofRefused | null = null

/** Hears each refused device proof; the audit log, which cannot be imported here without a cycle. */
export function onProofRefused(listener: ProofRefused): void {
  proofRefused = listener
}

async function serveDevice(c: Context, next: Next, url: string) {
  let device: DeviceIdentity
  try {
    const authorization = c.req.header('authorization') ?? ''
    device = await verifyDeviceProof({ authorization, method: c.req.method, url })
  } catch (e) {
    if (!(e instanceof ProofFailure)) {
      throw e
    }
    process.stderr.write(`access: refused a device proof for ${c.req.method} ${loggedPath(c)}: ${e.message}\n`)
    await proofRefused?.(c, e.message)
    return fail(c, 401, 'Device refused', 'The device proof was not accepted; pair the device again if this lasts')
  }
  const source = { deviceId: device.id, name: device.name, scopes: device.scopes, showNames: device.show_names }
  await requestSources.run({ via: 'device', ...source }, next)
  return undefined
}

/**
 * A passkey session or an open sign-in path first. Without them, Cloudflare Access decides while
 * Seti's sign-in is not enforced; once it is, or with no Access configured, the API answers 401
 * and the static shell loads, so the browser can sign in.
 */
async function servePublicHost(c: Context, next: Next, access: PublicAccess, verify: AccessVerifier | null) {
  if (c.req.path.startsWith(HOOKS_PREFIX) || isPublicShareRequest(c.req.method, c.req.path)) {
    await next()
    return undefined
  }
  if (isDeviceProof(c.req.header('authorization') ?? '')) {
    return serveDevice(c, next, `${access.origin}${c.req.path}`)
  }
  const session = await requestSession(c, true)
  if (session !== null) {
    const source: SessionRequest = { via: 'session', sessionId: session.id, passkey: session.passkey }
    return servePublic(c, next, source, `passkey ${session.passkey ?? 'removed'}`)
  }
  if (isOpenPath(c.req.path)) {
    await next()
    return undefined
  }
  if (access.cloudflare === null || verify === null || (await authEnforced())) {
    await next()
    return undefined
  }
  return serveAccess(c, next, access.cloudflare, verify)
}

async function serveLoopback(c: Context, next: Next, local: LocalAuth) {
  if (isPublicShareRequest(c.req.method, c.req.path)) {
    await next()
    return undefined
  }
  if (isDeviceProof(c.req.header('authorization') ?? '')) {
    return serveDevice(c, next, `http://${c.req.header('host') ?? ''}${c.req.path}`)
  }
  const caller = local.identify(c)
  if (caller !== null) {
    await requestSources.run({ via: caller === 'ea' ? 'ea' : 'local' }, next)
    return undefined
  }
  const session = await requestSession(c, false)
  if (session !== null) {
    await requestSources.run({ via: 'session', sessionId: session.id, passkey: session.passkey }, next)
    return undefined
  }
  await next()
  return undefined
}

export interface AccessGuardOptions {
  access: PublicAccess | null
  /** Verifies Cloudflare Access tokens; null when the public host has no Access in front. */
  verify: AccessVerifier | null
  /** Local token checks; the server's credentials when left out. */
  local?: LocalAuth
}

/**
 * Public-host requests need a passkey session or, while Seti's sign-in is not enforced, a valid
 * Access token. Cloudflare-forwarded requests must use the public host. Loopback requests are
 * tagged with the local caller their token names, or their passkey session; the API refuses
 * those with neither. Webhook deliveries under HOOKS_PREFIX are checked by their signature, and
 * a GET or HEAD of exactly a share's page or download by its token.
 */
export function accessGuard({ access, verify, local }: AccessGuardOptions): MiddlewareHandler {
  const guard = async (c: Context, next: Next) => {
    const hostname = (c.req.header('host') ?? '').replace(/:\d+$/, '').toLowerCase()
    if (access !== null && hostname === access.hostname) {
      const host = { hostname: access.hostname, origin: access.origin }
      return publicHosts.run(host, async () => servePublicHost(c, next, access, verify))
    }
    if (viaCloudflare(c.req.raw.headers)) {
      return access === null
        ? fail(c, 403, 'Forbidden', 'Public access is not configured on this Seti')
        : fail(c, 403, 'Forbidden', `Requests through Cloudflare must use Host ${access.hostname}`)
    }
    return serveLoopback(c, next, local ?? defaultLocalAuth())
  }
  return async (c, next) => requests.run(true, async () => guard(c, next))
}
