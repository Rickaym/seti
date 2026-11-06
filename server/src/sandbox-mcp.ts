import fs from 'node:fs'
import path from 'node:path'
import { urlAllowed, type SandboxMcpServer, type SandboxPolicy } from '@seti/shared'
import { connectorCredential } from './claude-credential.js'
import { CLAUDE_HOME } from './config.js'
import { MCP_PROXY_HOST } from './egress-hosts.js'
import {
  createMcpTokens,
  holdsToken,
  replaceFile,
  withStorageLock,
  type McpLogin,
  type McpTokens,
} from './mcp-oauth.js'
import { remoteServer, secretFree } from './sandbox-claude-json.js'

/** The MCP tokens of the host's Claude Code login, which only the egress proxy reads. */
export const mcpTokens: McpTokens = createMcpTokens(path.join(CLAUDE_HOME, '.credentials.json'))

/** The host's Claude Code config, whose user MCP servers sandboxes may start. */
export const hostClaudeJson = () => path.join(path.dirname(CLAUDE_HOME), '.claude.json')

const isHttps = (login: McpLogin) => login.url.protocol === 'https:'

const byName = (a: string, b: string) => a.localeCompare(b, 'en')

const httpsLogins = (tokens: McpTokens) => tokens.logins().filter(isHttps)

/** host:port of the remote MCP servers the host signed in to; the proxy adds their tokens. */
export function mcpTargets(tokens: McpTokens = mcpTokens, denied: ReadonlySet<string> = new Set()): string[] {
  const port = (url: URL) => (url.port === '' ? '443' : url.port)
  const targets = httpsLogins(tokens)
    .filter((login) => !denied.has(login.name))
    .map((login) => `${login.url.hostname}:${port(login.url)}`)
  return [...new Set(targets)].toSorted(byName)
}

/** Hosts the sandbox CA must sign for, so the proxy can add MCP tokens to their requests. */
export const mcpHosts = (tokens: McpTokens = mcpTokens) =>
  [...new Set(httpsLogins(tokens).map((login) => login.url.hostname))].toSorted(byName)

export const signedInServers = (tokens: McpTokens = mcpTokens) => new Set(tokens.logins().map((login) => login.name))

/** Servers whose requests the proxy signs with a host token, less those the task turned off. */
export const proxiedServers = (tokens: McpTokens = mcpTokens, denied: ReadonlySet<string> = new Set()) =>
  new Set(
    httpsLogins(tokens)
      .filter((login) => holdsToken(login) && !denied.has(login.name))
      .map((login) => login.name),
  )

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const filled = (value: unknown) => typeof value === 'string' && value !== ''

function readJsonFile(file: string): { data: Json; mode: number } | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (stat?.isFile() !== true) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isObject(parsed) ? { data: parsed, mode: stat.mode & 0o777 } : null
  } catch {
    return null
  }
}

/** The entries without those `drop` picks; null when it picks none. */
function without(entries: Json, drop: (key: string, value: unknown) => boolean): Json | null {
  const kept = Object.entries(entries).filter(([key, value]) => !drop(key, value))
  return kept.length === Object.keys(entries).length ? null : Object.fromEntries(kept)
}

const loginName = (key: string, entry: Json) =>
  typeof entry.serverName === 'string' ? entry.serverName : (key.split('|')[0] ?? key)

/**
 * Forgets what a sandbox's Claude Code noted when a proxied server once refused it: a sign-in
 * entry without a token, or a needs-auth mark, makes it skip the server and never try the proxy.
 */
export function forgetSandboxSignIns(claudeDir: string, proxied: ReadonlySet<string>): void {
  const credentials = path.join(claudeDir, '.credentials.json')
  if (readJsonFile(credentials) !== null) {
    withStorageLock(credentials, () => {
      const file = readJsonFile(credentials)
      const logins = file?.data.mcpOAuth
      if (file === null || !isObject(logins)) {
        return
      }
      const kept = without(
        logins,
        (key, entry) =>
          isObject(entry) &&
          !filled(entry.accessToken) &&
          !filled(entry.refreshToken) &&
          proxied.has(loginName(key, entry)),
      )
      if (kept !== null) {
        replaceFile(credentials, JSON.stringify({ ...file.data, mcpOAuth: kept }), file.mode)
      }
    })
  }
  const cache = path.join(claudeDir, 'mcp-needs-auth-cache.json')
  const marks = readJsonFile(cache)
  const kept = marks === null ? null : without(marks.data, (name) => proxied.has(name))
  if (marks !== null && kept !== null) {
    replaceFile(cache, JSON.stringify(kept), marks.mode)
  }
}

function userServers(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    const servers = typeof parsed === 'object' && parsed !== null && 'mcpServers' in parsed ? parsed.mcpServers : null
    return typeof servers === 'object' && servers !== null ? (servers as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const NEEDS_LOGIN = 'Its sign-in expired and could not be refreshed: run /mcp in claude on the host.'

function loginRow(login: McpLogin, tokens: McpTokens): SandboxMcpServer {
  const state = tokens.state(login)
  return {
    name: login.name,
    host: login.url.hostname,
    auth: 'oauth',
    state,
    reason: state === 'ok' ? null : NEEDS_LOGIN,
  }
}

function configRow(name: string, server: unknown, policy: SandboxPolicy): SandboxMcpServer | null {
  const url = typeof server === 'object' && server !== null && 'url' in server ? server.url : null
  if (typeof url !== 'string') {
    return null
  }
  const host = URL.canParse(url) ? new URL(url).hostname : url
  if (remoteServer(server) === null || !secretFree(server)) {
    const reason =
      'It is configured with keys or a URL query, which stay outside the sandbox. A connection with a header ' +
      "for its host in the agent's credential lets the proxy add the keys instead."
    return { name, host, auth: 'none', state: 'refused', reason }
  }
  if (!urlAllowed(url, policy.allowed_domains)) {
    return { name, host, auth: 'none', state: 'refused', reason: `${host} is not on the allowed hosts list.` }
  }
  return { name, host, auth: 'none', state: 'ok', reason: null }
}

/**
 * The remote MCP servers sandboxed agents can use and whether they work: servers the host signed
 * in to, user servers without a sign-in, and claude.ai connectors through Anthropic's MCP proxy.
 */
export function sandboxMcpServers(
  policy: SandboxPolicy,
  tokens: McpTokens = mcpTokens,
  configFile: string = hostClaudeJson(),
  connector: () => string | null = () => connectorCredential(),
): SandboxMcpServer[] {
  const logins = tokens.logins()
  const signedIn = new Set(logins.map((login) => login.name))
  const configured = Object.entries(userServers(configFile))
    .filter(([name]) => !signedIn.has(name))
    .flatMap(([name, server]) => {
      const row = configRow(name, server, policy)
      return row === null ? [] : [row]
    })
  const connectors: SandboxMcpServer = {
    name: 'claude.ai connectors',
    host: MCP_PROXY_HOST,
    auth: 'connector',
    ...(connector() === null
      ? {
          state: 'needs_login',
          reason: 'Connectors need the Claude Code login on the host; a setup-token token cannot reach them.',
        }
      : { state: 'ok', reason: null }),
  }
  const rows = [...logins.map((login) => loginRow(login, tokens)), ...configured]
  return [...rows.toSorted((a, b) => a.name.localeCompare(b.name, 'en')), connectors]
}
