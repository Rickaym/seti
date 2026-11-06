import fs from 'node:fs'
import path from 'node:path'
import { audit } from './audit.js'
import { CLAUDE_HOME, SETI_HOME } from './config.js'
import { replaceFile, withStorageLock } from './mcp-oauth.js'
import type { SecretBox } from './secret-box.js'
import { storeBox } from './secrets.js'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const objectOr = (value: unknown): Json => (isObject(value) ? value : {})

const CHECK_MS = 5000
const SEAL_CONTEXT = 'claude-mcp-logins'

/**
 * Claude Code's MCP sign-ins as last seen in its credentials file. `wiped` means Claude Code has
 * since dropped them all, as its logout does, and they go back once it is signed in again.
 */
interface Kept {
  logins: Json
  clientConfig: Json
  wiped: boolean
}

const EMPTY: Kept = { logins: {}, clientConfig: {}, wiped: false }

type Credentials = { state: 'missing' } | { state: 'unreadable' } | { state: 'present'; data: Json; mode: number }

function readCredentials(file: string): Credentials {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (stat === undefined) {
    return { state: 'missing' }
  }
  if (!stat.isFile()) {
    return { state: 'unreadable' }
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isObject(parsed) ? { state: 'present', data: parsed, mode: stat.mode & 0o777 } : { state: 'unreadable' }
  } catch {
    return { state: 'unreadable' }
  }
}

const signedIn = (data: Json) => {
  const oauth = data.claudeAiOauth
  return isObject(oauth) && typeof oauth.accessToken === 'string' && oauth.accessToken !== ''
}

const serverName = (key: string, entry: unknown) =>
  isObject(entry) && typeof entry.serverName === 'string' ? entry.serverName : (key.split('|')[0] ?? key)

const missingFrom = (kept: Json, current: Json): Json =>
  Object.fromEntries(Object.entries(kept).filter(([key]) => !(key in current)))

type KeepResult =
  | { action: 'none' }
  | { action: 'kept' }
  | { action: 'wiped' }
  | { action: 'busy' }
  | { action: 'restored'; servers: string[] }

export interface KeeperOptions {
  /** Claude Code's credentials file. */
  credentials: string
  /** Where Seti keeps its sealed copy of the MCP sign-ins. */
  store: string
  box: SecretBox
  log?: (line: string) => void
}

export interface McpLoginKeeper {
  check: () => KeepResult
}

/**
 * Keeps a sealed copy of Claude Code's MCP OAuth sign-ins and puts them back after a Claude Code
 * logout wiped its credentials file, once a Claude login is there again. Sign-ins removed one by
 * one, with the rest of the file intact, stay removed.
 */
export function createMcpLoginKeeper(options: KeeperOptions): McpLoginKeeper {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  let memo: Kept | null = null

  const load = (): Kept => {
    if (memo !== null) {
      return memo
    }
    memo = EMPTY
    try {
      const parsed: unknown = JSON.parse(options.box.open(fs.readFileSync(options.store, 'utf8'), SEAL_CONTEXT))
      if (isObject(parsed)) {
        memo = {
          logins: objectOr(parsed.logins),
          clientConfig: objectOr(parsed.clientConfig),
          wiped: parsed.wiped === true,
        }
      }
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) {
        log('mcp-keeper: the kept MCP sign-ins could not be opened; keeping the current ones instead')
      }
    }
    return memo
  }

  const save = (next: Kept) => {
    replaceFile(options.store, options.box.seal(JSON.stringify(next), SEAL_CONTEXT), 0o600)
    memo = next
  }

  const restore = (kept: Kept): KeepResult => {
    const merged = withStorageLock(options.credentials, () => {
      const now = readCredentials(options.credentials)
      if (now.state !== 'present' || !signedIn(now.data)) {
        return null
      }
      const logins = objectOr(now.data.mcpOAuth)
      const clientConfig = objectOr(now.data.mcpOAuthClientConfig)
      const addLogins = missingFrom(kept.logins, logins)
      const addConfig = missingFrom(kept.clientConfig, clientConfig)
      const next: Json = { ...now.data, mcpOAuth: { ...addLogins, ...logins } }
      if (Object.keys(addConfig).length > 0) {
        next.mcpOAuthClientConfig = { ...addConfig, ...clientConfig }
      }
      if (Object.keys(addLogins).length > 0 || Object.keys(addConfig).length > 0) {
        replaceFile(options.credentials, JSON.stringify(next), now.mode)
      }
      return { next, added: addLogins }
    })
    if (merged === undefined) {
      return { action: 'busy' }
    }
    if (merged === null) {
      return { action: 'none' }
    }
    save({
      logins: objectOr(merged.next.mcpOAuth),
      clientConfig: objectOr(merged.next.mcpOAuthClientConfig),
      wiped: false,
    })
    const servers = Object.entries(merged.added).map(([key, entry]) => serverName(key, entry))
    return { action: 'restored', servers: servers.toSorted((a, b) => a.localeCompare(b, 'en')) }
  }

  const check = (): KeepResult => {
    const current = readCredentials(options.credentials)
    if (current.state === 'unreadable') {
      return { action: 'none' }
    }
    const kept = load()
    const held = Object.keys(kept.logins).length > 0
    const dropped = held && (current.state === 'missing' || !isObject(current.data.mcpOAuth))
    if (kept.wiped || dropped) {
      if (current.state === 'present' && signedIn(current.data)) {
        return restore(kept)
      }
      if (kept.wiped) {
        return { action: 'none' }
      }
      save({ ...kept, wiped: true })
      return { action: 'wiped' }
    }
    if (current.state === 'missing' || !isObject(current.data.mcpOAuth)) {
      return { action: 'none' }
    }
    const next: Kept = {
      logins: current.data.mcpOAuth,
      clientConfig: objectOr(current.data.mcpOAuthClientConfig),
      wiped: false,
    }
    if (JSON.stringify(next) === JSON.stringify(kept)) {
      return { action: 'none' }
    }
    save(next)
    return { action: 'kept' }
  }

  return { check }
}

/** Watches the host's Claude Code credentials so a logout there does not cost the MCP sign-ins. */
export function startMcpLoginKeeper(): void {
  const keeper = createMcpLoginKeeper({
    credentials: path.join(CLAUDE_HOME, '.credentials.json'),
    store: path.join(SETI_HOME, 'claude-mcp-logins.sealed'),
    box: storeBox(),
  })
  const run = () => {
    try {
      const result = keeper.check()
      if (result.action === 'restored' && result.servers.length > 0) {
        const names = result.servers.join(', ')
        process.stderr.write(`mcp-keeper: put back ${String(result.servers.length)} MCP sign-ins: ${names}\n`)
        void audit.record({
          actor: 'system',
          kind: 'mcp.signins_restored',
          subject_type: 'system',
          summary: `Put back the MCP sign-ins a Claude Code logout removed: ${names}`,
          detail: { servers: result.servers },
        })
      }
    } catch (e) {
      process.stderr.write(`mcp-keeper: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  run()
  setInterval(run, CHECK_MS).unref()
}
