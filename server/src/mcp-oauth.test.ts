import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMcpTokens, loginFor, readMcpLogins, writeRefreshed } from './mcp-oauth.js'

const OLD_ACCESS = ['old', 'access', 'value'].join('-')
const OLD_REFRESH = ['old', 'refresh', 'value'].join('-')
const NEW_ACCESS = ['new', 'access', 'value'].join('-')
const NEW_REFRESH = ['new', 'refresh', 'value'].join('-')
const LOGIN_TOKEN = ['claude', 'login', 'value'].join('-')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-mcp-oauth-'))
const file = path.join(dir, '.credentials.json')
let server: http.Server
let base = ''
const grants: URLSearchParams[] = []
let grantStatus = 200
let grantBody: Record<string, unknown> = {}

type Json = Record<string, unknown>

function entry(patch: Json = {}): Json {
  return {
    serverName: 'tracker',
    serverUrl: 'https://mcp.tracker.test/mcp',
    accessToken: OLD_ACCESS,
    refreshToken: OLD_REFRESH,
    expiresAt: Date.now() - 1000,
    clientId: 'client-1',
    discoveryState: { authorizationServerUrl: base, resourceMetadataUrl: 'x', oauthMetadataFound: true },
    ...patch,
  }
}

function writeFile(logins: Record<string, Json>): void {
  const data = { mcpOAuth: logins, claudeAiOauth: { accessToken: LOGIN_TOKEN, scopes: ['user:inference'] } }
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
}

const stored = () =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpOAuth: Record<string, Json>; claudeAiOauth: Json }

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ issuer: base, token_endpoint: `${base}/token` }))
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      grants.push(new URLSearchParams(body))
      res.writeHead(grantStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify(grantBody))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

beforeEach(() => {
  grants.length = 0
  grantStatus = 200
  grantBody = { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600, token_type: 'Bearer' }
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const mcpUrl = new URL('https://mcp.tracker.test/mcp')

describe('loginFor', () => {
  it('matches the server URL by path prefix, or the only login of a host', () => {
    writeFile({
      'a|1': entry({ serverName: 'a', serverUrl: 'https://one.test/mcp' }),
      'b|2': entry({ serverName: 'b', serverUrl: 'https://two.test/v1/mcp' }),
      'c|3': entry({ serverName: 'c', serverUrl: 'https://two.test/other' }),
      'd|4': entry({ serverName: 'd', serverUrl: 'http://plain.test/mcp' }),
    })
    const logins = readMcpLogins(file)
    expect(logins.map((login) => login.name)).toEqual(['a', 'b', 'c'])
    expect(loginFor(logins, new URL('https://one.test/mcp'))?.name).toBe('a')
    expect(loginFor(logins, new URL('https://one.test/messages?session=1'))?.name).toBe('a')
    expect(loginFor(logins, new URL('https://one.test/.well-known/oauth-protected-resource'))).toBeNull()
    expect(loginFor(logins, new URL('https://two.test/v1/mcp/stream'))?.name).toBe('b')
    expect(loginFor(logins, new URL('https://two.test/elsewhere'))).toBeNull()
    expect(loginFor(logins, new URL('https://three.test/mcp'))).toBeNull()
  })

  it('picks the server on a shared URL that holds a token over a sign-in that never finished', () => {
    const shared = 'https://staging.test/api/mcp'
    writeFile({
      'staging|1': entry({ serverName: 'staging', serverUrl: shared, accessToken: '', refreshToken: '' }),
      'staging-mine|2': entry({ serverName: 'staging-mine', serverUrl: shared }),
    })
    expect(loginFor(readMcpLogins(file), new URL(shared))?.name).toBe('staging-mine')
  })
})

describe('tokenFor among allowed logins', () => {
  it("skips a login the task turned off and uses the other server's token on the same URL", async () => {
    const shared = 'https://staging.test/api/mcp'
    writeFile({
      'staging|1': entry({ serverName: 'staging', serverUrl: shared, expiresAt: Date.now() + 3_600_000 }),
      'staging-mine|2': entry({
        serverName: 'staging-mine',
        serverUrl: shared,
        accessToken: NEW_ACCESS,
        expiresAt: Date.now() + 3_600_000,
      }),
    })
    const tokens = createMcpTokens(file)
    expect(await tokens.tokenFor(new URL(shared))).toBe(OLD_ACCESS)
    expect(await tokens.tokenFor(new URL(shared), (login) => login.name !== 'staging')).toBe(NEW_ACCESS)
    expect(await tokens.tokenFor(new URL(shared), () => false)).toBeNull()
  })

  it('gives a newly added server its token although an unfinished sign-in on its URL comes first', async () => {
    const shared = 'https://staging.test/api/mcp'
    writeFile({
      'web-staging|49a1': entry({
        serverName: 'web-staging',
        serverUrl: shared,
        accessToken: undefined,
        refreshToken: undefined,
      }),
      'web-staging-new|49a1': entry({
        serverName: 'web-staging-new',
        serverUrl: shared,
        accessToken: NEW_ACCESS,
        expiresAt: Date.now() + 3_600_000,
      }),
    })
    const logins = readMcpLogins(file)
    expect(logins.map((login) => login.name)).toEqual(['web-staging', 'web-staging-new'])
    expect(await createMcpTokens(file).tokenFor(new URL(shared))).toBe(NEW_ACCESS)
  })
})

describe('createMcpTokens', () => {
  it('hands out a live access token without refreshing', async () => {
    writeFile({ 'tracker|1': entry({ expiresAt: Date.now() + 3_600_000 }) })
    const tokens = createMcpTokens(file)
    expect(await tokens.tokenFor(mcpUrl)).toBe(OLD_ACCESS)
    expect(grants).toEqual([])
  })

  it('refreshes an expired token on the host and writes it back the way Claude Code stores it', async () => {
    writeFile({ 'tracker|1': entry(), 'other|2': entry({ serverName: 'other', serverUrl: 'https://o.test/mcp' }) })
    const tokens = createMcpTokens(file)
    const [first, second] = await Promise.all([tokens.tokenFor(mcpUrl), tokens.tokenFor(mcpUrl)])
    expect([first, second]).toEqual([NEW_ACCESS, NEW_ACCESS])
    expect(grants).toHaveLength(1)
    expect(Object.fromEntries(grants[0] ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: OLD_REFRESH,
      client_id: 'client-1',
      resource: 'https://mcp.tracker.test/mcp',
    })
    const data = stored()
    expect(data.mcpOAuth['tracker|1']).toMatchObject({ accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH })
    expect(data.mcpOAuth['tracker|1']?.expiresAt).toBeGreaterThan(Date.now() + 3_500_000)
    expect(data.mcpOAuth['other|2']?.accessToken).toBe(OLD_ACCESS)
    expect(data.claudeAiOauth.accessToken).toBe(LOGIN_TOKEN)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('\n')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(['.credentials.json'])
    expect(await tokens.tokenFor(mcpUrl)).toBe(NEW_ACCESS)
    expect(grants).toHaveLength(1)
  })

  it('stops at a refused grant, says the server needs a new sign-in, and logs no token', async () => {
    writeFile({ 'tracker|1': entry() })
    grantStatus = 400
    grantBody = { error: 'invalid_grant', error_description: `token ${OLD_REFRESH} revoked` }
    const errors: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errors.push(String(chunk))
      return true
    })
    const tokens = createMcpTokens(file)
    expect(await tokens.tokenFor(mcpUrl)).toBeNull()
    expect(await tokens.tokenFor(mcpUrl)).toBeNull()
    expect(grants).toHaveLength(1)
    const [login] = tokens.logins()
    expect(login === undefined ? null : tokens.state(login)).toBe('needs_login')
    expect(errors.join('')).toContain('tracker')
    for (const secret of [OLD_ACCESS, OLD_REFRESH]) {
      expect(errors.join('')).not.toContain(secret)
    }
    expect(stored().mcpOAuth['tracker|1']?.accessToken).toBe(OLD_ACCESS)
  })

  it('needs a new sign-in for an expired login without a refresh token', async () => {
    writeFile({ 'tracker|1': entry({ refreshToken: undefined }) })
    const tokens = createMcpTokens(file)
    expect(await tokens.tokenFor(mcpUrl)).toBeNull()
    const [login] = tokens.logins()
    expect(login === undefined ? null : tokens.state(login)).toBe('needs_login')
    expect(grants).toEqual([])
  })
})

describe('writeRefreshed', () => {
  it('leaves an entry that changed meanwhile, and a linked file, alone', () => {
    writeFile({ 'tracker|1': entry() })
    const [before] = readMcpLogins(file)
    if (before === undefined) {
      throw new Error('no login')
    }
    writeFile({ 'tracker|1': entry({ accessToken: 'someone-else-refreshed' }) })
    expect(writeRefreshed(file, before, { accessToken: NEW_ACCESS })).toBe(false)
    expect(stored().mcpOAuth['tracker|1']?.accessToken).toBe('someone-else-refreshed')
    writeFile({ 'tracker|1': entry() })
    const link = path.join(dir, 'link.json')
    fs.symlinkSync(file, link)
    expect(writeRefreshed(link, before, { accessToken: NEW_ACCESS })).toBe(false)
    fs.rmSync(link)
  })

  it('waits for Claude Code to finish writing its credentials', () => {
    writeFile({ 'tracker|1': entry() })
    const [before] = readMcpLogins(file)
    if (before === undefined) {
      throw new Error('no login')
    }
    const lock = path.join(dir, '.storage-write.lock')
    fs.mkdirSync(lock)
    expect(writeRefreshed(file, before, { accessToken: NEW_ACCESS })).toBe(false)
    expect(stored().mcpOAuth['tracker|1']?.accessToken).toBe(OLD_ACCESS)
    fs.rmdirSync(lock)
    expect(writeRefreshed(file, before, { accessToken: NEW_ACCESS })).toBe(true)
    expect(stored().mcpOAuth['tracker|1']?.accessToken).toBe(NEW_ACCESS)
    expect(fs.existsSync(lock)).toBe(false)
  })
})
