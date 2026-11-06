import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SandboxMcpState } from '@seti/shared'

/** How early a token counts as expired, so a request never leaves with one about to lapse. */
const EXPIRY_SKEW_MS = 60_000
/** A refresh that failed for a reason other than a dead grant is retried no sooner than this. */
const RETRY_MS = 60_000
const REFRESH_TIMEOUT_MS = 15_000

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

/** One remote MCP server the host's Claude Code signed in to, as stored under `mcpOAuth`. */
export interface McpLogin {
  key: string
  name: string
  url: URL
  accessToken: string | undefined
  refreshToken: string | undefined
  expiresAt: number | undefined
  clientId: string | undefined
  clientSecret: string | undefined
  authorizationServer: string | undefined
  metadataUrl: string | undefined
}

function parseLogin(key: string, entry: unknown): McpLogin | null {
  if (!isObject(entry)) {
    return null
  }
  const serverUrl = text(entry.serverUrl)
  if (serverUrl === undefined || !URL.canParse(serverUrl)) {
    return null
  }
  const url = new URL(serverUrl)
  if (url.protocol !== 'https:' && !isLoopback(url)) {
    return null
  }
  const discovery = isObject(entry.discoveryState) ? entry.discoveryState : {}
  return {
    key,
    name: text(entry.serverName) ?? key.split('|')[0] ?? key,
    url,
    accessToken: text(entry.accessToken),
    refreshToken: text(entry.refreshToken),
    expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : undefined,
    clientId: text(entry.clientId),
    clientSecret: text(entry.clientSecret),
    authorizationServer: text(discovery.authorizationServerUrl),
    metadataUrl: text(discovery.authServerMetadataUrl),
  }
}

const isLoopback = (url: URL) => url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)

function readFile(file: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The MCP logins in a Claude Code credentials file; never throws. */
export function readMcpLogins(file: string): McpLogin[] {
  const logins = readFile(file)?.mcpOAuth
  if (!isObject(logins)) {
    return []
  }
  return Object.entries(logins).flatMap(([key, entry]) => {
    const login = parseLogin(key, entry)
    return login === null ? [] : [login]
  })
}

function trimSlash(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') {
    end -= 1
  }
  return value.slice(0, end)
}

/** A login that holds a token, so a request can carry it now or after a refresh. */
export const holdsToken = (login: McpLogin) => login.accessToken !== undefined || login.refreshToken !== undefined

/** Longer server paths first; on one path, a login that holds a token first. */
const rank = (login: McpLogin) => login.url.pathname.length * 2 + Number(holdsToken(login))

const underPath = (request: URL) => (login: McpLogin) => {
  const base = trimSlash(login.url.pathname)
  return request.pathname === base || request.pathname.startsWith(`${base}/`) || base === ''
}

/**
 * The login whose server URL the request falls under, or the only one on its host. Of several
 * servers on one URL, one that holds a token wins over a sign-in that never finished.
 */
export function loginFor(logins: readonly McpLogin[], request: URL): McpLogin | null {
  const onHost = logins.filter((login) => login.url.host === request.host)
  const byPrefix = onHost.filter(underPath(request)).toSorted((a, b) => rank(b) - rank(a))
  if (byPrefix[0] !== undefined) {
    return byPrefix[0]
  }
  return onHost.length === 1 && !request.pathname.startsWith('/.well-known/') ? (onHost[0] ?? null) : null
}

const expired = (login: McpLogin, now: number) =>
  login.expiresAt !== undefined && login.expiresAt - EXPIRY_SKEW_MS <= now

interface TokenResponse {
  accessToken: string
  refreshToken: string | undefined
  expiresIn: number | undefined
  scope: string | undefined
}

/** The refresh grant failed for good: the host must sign in to the server again. */
class DeadGrantError extends Error {}

export type Fetch = typeof fetch

function metadataUrls(login: McpLogin): string[] {
  if (login.metadataUrl !== undefined) {
    return [login.metadataUrl]
  }
  const issuer = new URL(login.authorizationServer ?? login.url.origin)
  const suffix = trimSlash(issuer.pathname)
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${issuer.origin}/.well-known/openid-configuration${suffix}`,
    `${issuer.origin}${suffix}/.well-known/openid-configuration`,
  ]
}

const allowedEndpoint = (value: string) =>
  URL.canParse(value) && (new URL(value).protocol === 'https:' || isLoopback(new URL(value)))

async function tokenEndpoint(login: McpLogin, fetcher: Fetch): Promise<string> {
  for (const url of metadataUrls(login).filter(allowedEndpoint)) {
    try {
      const res = await fetcher(url, { signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) })
      const body: unknown = res.ok ? await res.json() : null
      const endpoint = isObject(body) ? text(body.token_endpoint) : undefined
      if (endpoint !== undefined && allowedEndpoint(endpoint)) {
        return endpoint
      }
    } catch {
      continue
    }
  }
  throw new Error(`no token endpoint found for ${login.name}`)
}

async function refreshGrant(login: McpLogin, refreshToken: string, fetcher: Fetch): Promise<TokenResponse> {
  const endpoint = await tokenEndpoint(login, fetcher)
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  if (login.clientId !== undefined) {
    form.set('client_id', login.clientId)
  }
  if (login.clientSecret !== undefined) {
    form.set('client_secret', login.clientSecret)
  }
  form.set('resource', login.url.href)
  const res = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  })
  const body: unknown = await res.json().catch(() => null)
  const json = isObject(body) ? body : {}
  if (!res.ok) {
    const error = text(json.error) ?? `HTTP ${String(res.status)}`
    if (error === 'invalid_grant' || error === 'invalid_client' || error === 'unauthorized_client') {
      throw new DeadGrantError(`${login.name} refused the refresh: ${error}`)
    }
    throw new Error(`${login.name} could not refresh: ${error}`)
  }
  const accessToken = text(json.access_token)
  if (accessToken === undefined) {
    throw new Error(`${login.name} answered the refresh without an access token`)
  }
  return {
    accessToken,
    refreshToken: text(json.refresh_token),
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    scope: text(json.scope),
  }
}

const errorCode = (e: unknown) => (e instanceof Error && 'code' in e ? e.code : undefined)

/**
 * Runs `write` holding the lock Claude Code takes for every write to its credential store, a
 * proper-lockfile directory beside the file; undefined when another process holds it.
 */
export function withStorageLock<T>(file: string, write: () => T): T | undefined {
  const lock = path.join(path.dirname(file), '.storage-write.lock')
  try {
    fs.mkdirSync(lock)
  } catch (e) {
    if (errorCode(e) === 'EEXIST') {
      return undefined
    }
    throw e
  }
  try {
    return write()
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

/** Replaces a file through a temporary file and a rename, so readers never see half of it. */
export function replaceFile(file: string, content: string, mode: number): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.seti-${randomBytes(6).toString('hex')}`)
  try {
    fs.writeFileSync(temp, content, { mode, flag: 'wx' })
    fs.chmodSync(temp, mode)
    fs.renameSync(temp, file)
  } catch (e) {
    fs.rmSync(temp, { force: true })
    throw e
  }
}

/**
 * Stores refreshed tokens under Claude Code's write lock. False when the entry changed meanwhile,
 * the file is a link, or another process is writing it.
 */
export function writeRefreshed(file: string, before: McpLogin, update: Json): boolean {
  return withStorageLock(file, () => writeRefreshedLocked(file, before, update)) ?? false
}

function writeRefreshedLocked(file: string, before: McpLogin, update: Json): boolean {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  const data = readFile(file)
  const logins = data?.mcpOAuth
  if (stat?.isFile() !== true || data === null || !isObject(logins) || !isObject(logins[before.key])) {
    return false
  }
  const entry = logins[before.key] as Json
  if (text(entry.accessToken) !== before.accessToken || text(entry.refreshToken) !== before.refreshToken) {
    return false
  }
  logins[before.key] = { ...entry, ...update }
  replaceFile(file, JSON.stringify(data), stat.mode & 0o777)
  return true
}

export interface McpTokens {
  /** Every MCP login on the host, read fresh. */
  logins: () => McpLogin[]
  /** A usable token for a request URL among the allowed logins, refreshed when expired; else null. */
  tokenFor: (request: URL, allowed?: (login: McpLogin) => boolean) => Promise<string | null>
  /** Whether the sandbox can use a login: ok, or needs a new sign-in on the host. */
  state: (login: McpLogin) => SandboxMcpState
}

interface Failure {
  refreshToken: string
  dead: boolean
  at: number
}

/** MCP OAuth tokens of the host's Claude Code, refreshed on the host so no sandbox holds them. */
export function createMcpTokens(file: string, fetcher: Fetch = fetch, now: () => number = Date.now): McpTokens {
  const inFlight = new Map<string, Promise<string | null>>()
  const failures = new Map<string, Failure>()
  const refreshed = new Map<string, { before: McpLogin; token: string; expiresAt: number | undefined }>()

  const failed = (login: McpLogin) => {
    const failure = failures.get(login.key)
    return failure !== undefined && failure.refreshToken === login.refreshToken ? failure : undefined
  }

  const refresh = async (login: McpLogin, refreshToken: string): Promise<string | null> => {
    try {
      const grant = await refreshGrant(login, refreshToken, fetcher)
      const expiresAt = grant.expiresIn === undefined ? undefined : now() + grant.expiresIn * 1000
      const update: Json = {
        accessToken: grant.accessToken,
        ...(grant.refreshToken === undefined ? {} : { refreshToken: grant.refreshToken }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(grant.scope === undefined ? {} : { scope: grant.scope }),
      }
      if (!writeRefreshed(file, login, update)) {
        const current = readMcpLogins(file).find((entry) => entry.key === login.key)
        if (current?.accessToken !== undefined && !expired(current, now())) {
          return current.accessToken
        }
        refreshed.set(login.key, { before: login, token: grant.accessToken, expiresAt })
        process.stderr.write(`sandbox: kept the refreshed ${login.name} MCP token in memory only\n`)
      }
      failures.delete(login.key)
      return grant.accessToken
    } catch (e) {
      const dead = e instanceof DeadGrantError
      failures.set(login.key, { refreshToken, dead, at: now() })
      const reason = e instanceof Error ? e.message : String(e)
      process.stderr.write(`sandbox: refreshing the ${login.name} MCP token failed: ${reason}\n`)
      return null
    }
  }

  const heldInMemory = (login: McpLogin): string | null => {
    const held = refreshed.get(login.key)
    if (held === undefined) {
      return null
    }
    const same = held.before.accessToken === login.accessToken && held.before.refreshToken === login.refreshToken
    if (!same) {
      refreshed.delete(login.key)
      return null
    }
    return held.expiresAt === undefined || held.expiresAt - EXPIRY_SKEW_MS > now() ? held.token : null
  }

  const tokenFor = async (request: URL, allowed: (login: McpLogin) => boolean = () => true) => {
    const login = loginFor(readMcpLogins(file).filter(allowed), request)
    if (login === null) {
      return null
    }
    const held = heldInMemory(login)
    if (held !== null) {
      return held
    }
    if (login.accessToken !== undefined && !expired(login, now())) {
      return login.accessToken
    }
    const failure = failed(login)
    if (login.refreshToken === undefined || failure?.dead === true) {
      return null
    }
    if (failure !== undefined && now() - failure.at < RETRY_MS) {
      return null
    }
    const running = inFlight.get(login.key) ?? refresh(login, login.refreshToken)
    inFlight.set(login.key, running)
    try {
      return await running
    } finally {
      inFlight.delete(login.key)
    }
  }

  const state = (login: McpLogin): SandboxMcpState => {
    if (heldInMemory(login) !== null) {
      return 'ok'
    }
    if (login.accessToken !== undefined && !expired(login, now())) {
      return 'ok'
    }
    return login.refreshToken !== undefined && failed(login)?.dead !== true ? 'ok' : 'needs_login'
  }

  return { logins: () => readMcpLogins(file), tokenFor, state }
}
