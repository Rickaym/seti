import fs from 'node:fs'
import path from 'node:path'
import { mcpSignIn, type CapabilitiesSnapshot } from '@seti/shared'
import { ownProjects, readHostConfig } from './mcp-borrowed.js'
import { holdsToken, type McpTokens } from './mcp-oauth.js'
import { mcpTokens } from './sandbox-mcp.js'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

export const hasClientId = (config: unknown): boolean =>
  isObject(config) &&
  isObject(config.oauth) &&
  typeof config.oauth.clientId === 'string' &&
  config.oauth.clientId !== ''

const serversOf = (entry: unknown): Json => (isObject(entry) && isObject(entry.mcpServers) ? entry.mcpServers : {})

function readMcpJson(dir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Servers a session in `cwd` gets whose user, local or project config names an OAuth client ID. */
export function clientIdServers(cwd: string, host: Json = readHostConfig()): Set<string> {
  const dirs = ownProjects(cwd)
  const projects = isObject(host.projects) ? host.projects : {}
  const configs = [host, ...dirs.map((dir) => projects[dir]), ...dirs.map(readMcpJson)].map(serversOf)
  return new Set(configs.flatMap((servers) => Object.keys(servers).filter((name) => hasClientId(servers[name]))))
}

export const tokenServers = (tokens: McpTokens = mcpTokens): Set<string> =>
  new Set(
    tokens
      .logins()
      .filter(holdsToken)
      .map((login) => login.name),
  )

/** The snapshot with each server's status and sign-in following the host's client IDs and tokens. */
export function withSignIn(
  snapshot: CapabilitiesSnapshot,
  clientIds: ReadonlySet<string> = clientIdServers(snapshot.cwd),
  tokens: ReadonlySet<string> = tokenServers(),
): CapabilitiesSnapshot {
  return {
    ...snapshot,
    servers: snapshot.servers.map((server) => ({
      ...server,
      ...mcpSignIn({
        status: server.status,
        transport: server.transport?.type ?? null,
        clientId: clientIds.has(server.name),
        tokenStored: tokens.has(server.name),
      }),
    })),
  }
}
