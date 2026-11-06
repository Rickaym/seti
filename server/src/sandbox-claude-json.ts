import fs from 'node:fs'

/** Keys of ~/.claude.json a sandbox gets: onboarding state and the account profile, no keys. */
const KEPT_KEYS = [
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'userID',
  'firstStartTime',
  'oauthAccount',
  'theme',
]

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function readJson(file: string): Json {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const isEmpty = (value: unknown) => value === undefined || (isObject(value) && Object.keys(value).length === 0)

/** An MCP server that carries no secret of its own: no env, headers or URL query. */
export function secretFree(server: unknown): boolean {
  if (!isObject(server) || !isEmpty(server.env) || !isEmpty(server.headers)) {
    return false
  }
  return typeof server.url !== 'string' || !server.url.includes('?')
}

/** A remote server's transport and URL, when it is one and its URL has no query to leak. */
export function remoteServer(server: unknown): { type: 'http' | 'sse'; url: string } | null {
  if (!isObject(server) || (server.type !== 'http' && server.type !== 'sse') || typeof server.url !== 'string') {
    return null
  }
  return server.url.includes('?') ? null : { type: server.type, url: server.url }
}

/**
 * The MCP servers a sandbox may start: those configured without secrets as they are, and as
 * transport and URL only those the proxy authenticates, by the host's OAuth sign-in or a header
 * rule of the task's profile. Servers the task turned off stay out.
 */
export function sandboxServers(
  servers: unknown,
  signedIn: ReadonlySet<string>,
  denied: ReadonlySet<string> = new Set(),
  covered: (host: string) => boolean = () => false,
): Json {
  if (!isObject(servers)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(servers).flatMap(([name, server]): [string, unknown][] => {
      if (denied.has(name)) {
        return []
      }
      if (secretFree(server)) {
        return [[name, server]]
      }
      const remote = remoteServer(server)
      const proxied = remote !== null && (signedIn.has(name) || covered(new URL(remote.url).hostname))
      return proxied ? [[name, remote]] : []
    }),
  )
}

export interface ClaudeJsonScope {
  /** Names of the MCP servers the host signed in to with OAuth. */
  signedIn: ReadonlySet<string>
  /** Project keys whose local MCP servers the sandbox gets, such as the task directory. */
  projects: readonly string[]
  /** Names of the MCP servers the task turned off. */
  denied?: ReadonlySet<string>
  /** Hosts a header rule of the task's profile covers; their servers go in without their keys. */
  covered?: (host: string) => boolean
  /** Local servers of other directories the task turned on, added as user servers. */
  borrowed?: Json
}

function projectServers(host: Json, sandbox: Json, scope: ClaudeJsonScope): Json | undefined {
  const hostProjects = isObject(host.projects) ? host.projects : {}
  const own = isObject(sandbox.projects) ? { ...sandbox.projects } : {}
  for (const key of scope.projects) {
    const hostEntry = hostProjects[key]
    const servers = sandboxServers(
      isObject(hostEntry) ? hostEntry.mcpServers : undefined,
      scope.signedIn,
      scope.denied,
      scope.covered,
    )
    const current = own[key]
    if (isObject(current) || Object.keys(servers).length > 0) {
      own[key] = { ...(isObject(current) ? current : {}), mcpServers: servers }
    }
  }
  return Object.keys(own).length > 0 ? own : undefined
}

/**
 * Writes the ~/.claude.json a sandbox sees: what Claude Code wrote there in earlier sessions of
 * the task, refreshed with the host's onboarding state, account profile and the MCP servers the
 * sandbox may start. API keys, OAuth tokens, project history and other secrets never reach it.
 */
export function sandboxClaudeJson(
  hostFile: string,
  sandboxFile: string,
  scope: ClaudeJsonScope = { signedIn: new Set(), projects: [] },
): void {
  const host = readJson(hostFile)
  const sandbox = readJson(sandboxFile)
  const next: Json = { ...sandbox, hasCompletedOnboarding: true }
  for (const key of KEPT_KEYS) {
    if (key in host) {
      next[key] = host[key]
    }
  }
  const user = { ...scope.borrowed, ...(isObject(host.mcpServers) ? host.mcpServers : {}) }
  next.mcpServers = sandboxServers(user, scope.signedIn, scope.denied, scope.covered)
  const projects = projectServers(host, sandbox, scope)
  if (projects !== undefined) {
    next.projects = projects
  }
  delete next.primaryApiKey
  delete next.customApiKeyResponses
  fs.writeFileSync(sandboxFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(sandboxFile, 0o600)
}
