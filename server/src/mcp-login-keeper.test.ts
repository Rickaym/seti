import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMcpLoginKeeper, type KeeperOptions } from './mcp-login-keeper.js'
import { createMcpTokens } from './mcp-oauth.js'
import { secretBox } from './secret-box.js'

const piece = (...parts: string[]) => parts.join('-')
const TRACKER_ACCESS = piece('tracker', 'access', 'value')
const TRACKER_REFRESH = piece('tracker', 'refresh', 'value')
const NOTES_ACCESS = piece('notes', 'access', 'value')
const CLIENT_SECRET = piece('tracker', 'client', 'secret')
const LOGIN_TOKEN = piece('claude', 'login', 'value')
const NEW_LOGIN_TOKEN = piece('claude', 'second', 'login')
const SECRETS = [TRACKER_ACCESS, TRACKER_REFRESH, NOTES_ACCESS, CLIENT_SECRET, LOGIN_TOKEN, NEW_LOGIN_TOKEN]

type Json = Record<string, unknown>

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-mcp-keeper-'))
let dir = ''
let options: KeeperOptions
const logged: string[] = []

const TRACKER = 'tracker|1111'
const NOTES = 'notes|2222'

function trackerEntry(patch: Json = {}): Json {
  return {
    serverName: 'tracker',
    serverUrl: 'https://mcp.tracker.test/mcp',
    accessToken: TRACKER_ACCESS,
    refreshToken: TRACKER_REFRESH,
    expiresAt: Date.now() + 3_600_000,
    clientId: 'client-1',
    ...patch,
  }
}

const notesEntry = (): Json => ({
  serverName: 'notes',
  serverUrl: 'https://mcp.notes.test/mcp',
  accessToken: NOTES_ACCESS,
  discoveryState: { authorizationServerUrl: 'https://auth.notes.test' },
})

const credentials = () => options.credentials

function writeCredentials(data: Json): void {
  fs.writeFileSync(credentials(), JSON.stringify(data), { mode: 0o600 })
}

const signedIn = (token = LOGIN_TOKEN): Json => ({ claudeAiOauth: { accessToken: token, scopes: ['user:inference'] } })

const read = () => JSON.parse(fs.readFileSync(credentials(), 'utf8')) as Json

function signedInWithMcp(): void {
  writeCredentials({
    ...signedIn(),
    mcpOAuth: { [TRACKER]: trackerEntry(), [NOTES]: notesEntry() },
    mcpOAuthClientConfig: { [TRACKER]: { clientSecret: CLIENT_SECRET } },
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root, 'case-'))
  fs.mkdirSync(path.join(dir, 'claude'))
  fs.mkdirSync(path.join(dir, 'seti'))
  logged.length = 0
  options = {
    credentials: path.join(dir, 'claude', '.credentials.json'),
    store: path.join(dir, 'seti', 'claude-mcp-logins.sealed'),
    box: secretBox(randomBytes(32)),
    log: (line) => logged.push(line),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('MCP login keeper', () => {
  it('keeps a sealed, owner-only copy of the MCP sign-ins', () => {
    signedInWithMcp()
    const keeper = createMcpLoginKeeper(options)
    expect(keeper.check()).toEqual({ action: 'kept' })
    expect(keeper.check()).toEqual({ action: 'none' })
    expect(fs.statSync(options.store).mode & 0o777).toBe(0o600)
    const sealed = fs.readFileSync(options.store, 'utf8')
    for (const secret of SECRETS) {
      expect(sealed).not.toContain(secret)
    }
  })

  it('puts the sign-ins back once Claude Code is signed in again after a logout', () => {
    signedInWithMcp()
    const keeper = createMcpLoginKeeper(options)
    keeper.check()

    fs.rmSync(credentials())
    expect(keeper.check()).toEqual({ action: 'wiped' })
    expect(fs.existsSync(credentials())).toBe(false)
    expect(keeper.check()).toEqual({ action: 'none' })

    writeCredentials(signedIn(NEW_LOGIN_TOKEN))
    expect(keeper.check()).toEqual({ action: 'restored', servers: ['notes', 'tracker'] })
    const data = read()
    expect(data.claudeAiOauth).toEqual(signedIn(NEW_LOGIN_TOKEN).claudeAiOauth)
    expect(data.mcpOAuth).toEqual({ [TRACKER]: trackerEntry({ expiresAt: expect.any(Number) }), [NOTES]: notesEntry() })
    expect(data.mcpOAuthClientConfig).toEqual({ [TRACKER]: { clientSecret: CLIENT_SECRET } })
    expect(fs.statSync(credentials()).mode & 0o777).toBe(0o600)
    expect(keeper.check()).toEqual({ action: 'none' })
  })

  it('waits for the Claude login when the logout leaves other keys behind', () => {
    signedInWithMcp()
    const keeper = createMcpLoginKeeper(options)
    keeper.check()
    writeCredentials({ coworkRemoteDevice: { id: 'device-1' } })
    expect(keeper.check()).toEqual({ action: 'wiped' })
    expect(read()).toEqual({ coworkRemoteDevice: { id: 'device-1' } })

    writeCredentials({ coworkRemoteDevice: { id: 'device-1' }, ...signedIn() })
    expect(keeper.check()).toMatchObject({ action: 'restored' })
    expect(read()).toMatchObject({ coworkRemoteDevice: { id: 'device-1' }, mcpOAuth: { [TRACKER]: {}, [NOTES]: {} } })
  })

  it('remembers a logout across a restart', () => {
    signedInWithMcp()
    createMcpLoginKeeper(options).check()
    fs.rmSync(credentials())
    createMcpLoginKeeper(options).check()
    writeCredentials(signedIn())
    expect(createMcpLoginKeeper(options).check()).toEqual({ action: 'restored', servers: ['notes', 'tracker'] })
  })

  it('restores after a logout and login that happened while Seti was not watching', () => {
    signedInWithMcp()
    createMcpLoginKeeper(options).check()
    writeCredentials(signedIn(NEW_LOGIN_TOKEN))
    expect(createMcpLoginKeeper(options).check()).toEqual({ action: 'restored', servers: ['notes', 'tracker'] })
  })

  it('leaves a sign-in removed on its own removed', () => {
    signedInWithMcp()
    const keeper = createMcpLoginKeeper(options)
    keeper.check()
    writeCredentials({
      ...signedIn(),
      mcpOAuth: { [TRACKER]: trackerEntry() },
      mcpOAuthClientConfig: { [TRACKER]: { clientSecret: CLIENT_SECRET } },
    })
    expect(keeper.check()).toEqual({ action: 'kept' })

    fs.rmSync(credentials())
    keeper.check()
    writeCredentials(signedIn())
    expect(keeper.check()).toEqual({ action: 'restored', servers: ['tracker'] })
    expect(Object.keys(read().mcpOAuth as Json)).toEqual([TRACKER])
    expect(read().mcpOAuthClientConfig).toEqual({ [TRACKER]: { clientSecret: CLIENT_SECRET } })
  })

  it('keeps sign-ins made after the login over the kept ones', () => {
    signedInWithMcp()
    const keeper = createMcpLoginKeeper(options)
    keeper.check()
    fs.rmSync(credentials())
    keeper.check()
    const fresh = trackerEntry({ accessToken: piece('fresh', 'access') })
    writeCredentials({ ...signedIn(), mcpOAuth: { [TRACKER]: fresh } })
    expect(keeper.check()).toEqual({ action: 'restored', servers: ['notes'] })
    expect(read().mcpOAuth).toEqual({ [TRACKER]: fresh, [NOTES]: notesEntry() })
  })

  it('waits while Claude Code holds its credential write lock', () => {
    signedInWithMcp()
    const keeper = createMcpLoginKeeper(options)
    keeper.check()
    fs.rmSync(credentials())
    keeper.check()
    writeCredentials(signedIn())
    const lock = path.join(path.dirname(credentials()), '.storage-write.lock')
    fs.mkdirSync(lock)
    expect(keeper.check()).toEqual({ action: 'busy' })
    expect(read()).toEqual(signedIn())
    expect(fs.existsSync(lock)).toBe(true)
    fs.rmdirSync(lock)
    expect(keeper.check()).toMatchObject({ action: 'restored' })
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('puts expired sign-ins back as they were, so they still ask for a sign-in', () => {
    const expired = trackerEntry({ refreshToken: undefined, expiresAt: Date.now() - 60_000 })
    writeCredentials({ ...signedIn(), mcpOAuth: { [TRACKER]: expired } })
    const keeper = createMcpLoginKeeper(options)
    keeper.check()
    fs.rmSync(credentials())
    keeper.check()
    writeCredentials(signedIn())
    keeper.check()
    const tokens = createMcpTokens(credentials())
    const [login] = tokens.logins()
    expect(login?.name).toBe('tracker')
    expect(login === undefined ? null : tokens.state(login)).toBe('needs_login')
  })

  it('does nothing when Claude Code never had MCP sign-ins', () => {
    writeCredentials(signedIn())
    const keeper = createMcpLoginKeeper(options)
    expect(keeper.check()).toEqual({ action: 'none' })
    fs.rmSync(credentials())
    expect(keeper.check()).toEqual({ action: 'none' })
    expect(fs.existsSync(options.store)).toBe(false)
  })

  it('skips a credentials file it cannot parse', () => {
    signedInWithMcp()
    const keeper = createMcpLoginKeeper(options)
    keeper.check()
    fs.writeFileSync(credentials(), '{"claudeAiOauth":', { mode: 0o600 })
    expect(keeper.check()).toEqual({ action: 'none' })
    expect(fs.readFileSync(credentials(), 'utf8')).toBe('{"claudeAiOauth":')
  })

  it('starts over from the current sign-ins when its copy was sealed under another key', () => {
    signedInWithMcp()
    createMcpLoginKeeper(options).check()
    const other = createMcpLoginKeeper({ ...options, box: secretBox(randomBytes(32)) })
    expect(other.check()).toEqual({ action: 'kept' })
    expect(logged).toEqual(['mcp-keeper: the kept MCP sign-ins could not be opened; keeping the current ones instead'])
  })

  it('never writes a token to its log or the process output', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const consoleLog = vi.spyOn(console, 'log').mockReturnValue()
    const consoleError = vi.spyOn(console, 'error').mockReturnValue()
    signedInWithMcp()
    const keeper = createMcpLoginKeeper(options)
    keeper.check()
    fs.rmSync(credentials())
    keeper.check()
    writeCredentials(signedIn(NEW_LOGIN_TOKEN))
    const result = keeper.check()
    createMcpLoginKeeper({ ...options, box: secretBox(randomBytes(32)) }).check()
    const output = [
      ...logged,
      JSON.stringify(result),
      ...[stderr, stdout, consoleLog, consoleError].flatMap((spy) => spy.mock.calls.map((call) => String(call[0]))),
    ].join('\n')
    for (const secret of SECRETS) {
      expect(output).not.toContain(secret)
    }
  })
})
