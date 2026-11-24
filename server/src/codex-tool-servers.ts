import { hostMatches, MCP_TRANSPORTS, type McpTransport, type ProxyGrant, type Task } from '@seti/shared'
import { ownProjects, readHostConfig, taskBorrowedServers } from './mcp-borrowed.js'
import { serverProblem } from './runtimes/capabilities.js'
import { sandboxServers } from './sandbox-claude-json.js'
import { signedInServers } from './sandbox-mcp.js'

type Json = Record<string, unknown>

/** A user's MCP server as a Codex agent gets it: what to start or reach, never a value. */
export type CodexToolServer =
  | { name: string; transport: 'stdio'; command: string; args: string[] }
  | { name: string; transport: 'http'; url: string }

/** A user's MCP server a Codex agent cannot use, and why, in words the user reads. */
export interface UnusableServer {
  name: string
  reason: string
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((each) => typeof each === 'string') ? value : null

/** The transport a Claude Code config entry names; an entry without one is a local server. */
const transportOf = (server: Json): McpTransport['type'] | null => {
  const type = server.type ?? 'stdio'
  return MCP_TRANSPORTS.find((each) => each === type) ?? null
}

/** One filtered server entry as Codex takes it, or why it cannot. */
function codexServer(name: string, server: unknown): CodexToolServer | UnusableServer {
  const type = isObject(server) ? transportOf(server) : null
  if (!isObject(server) || type === null) {
    return { name, reason: 'Its configuration cannot be read.' }
  }
  const problem = serverProblem('codex', { name, type, plugin: false })
  if (problem !== null) {
    return { name, reason: problem }
  }
  if (type === 'http' && typeof server.url === 'string') {
    return { name, transport: 'http', url: server.url }
  }
  const args = server.args === undefined ? [] : strings(server.args)
  if (type === 'stdio' && typeof server.command === 'string' && args !== null) {
    return { name, transport: 'stdio', command: server.command, args }
  }
  return { name, reason: 'Its configuration cannot be read.' }
}

/**
 * The user's MCP servers a Codex agent's sandbox may start or reach, read from Claude Code's
 * config with the filter sandboxed Claude Code agents get: servers of other folders the agent
 * turned on, then user servers, then the agent's folder's own; none the agent turned off; only
 * those configured without a value, or remote ones the egress proxy signs on their host.
 */
export function codexServersOf(
  host: Json,
  scope: { cwd: string; borrowed: Json; denied: ReadonlySet<string>; signedIn: ReadonlySet<string>; grant: ProxyGrant },
): { servers: CodexToolServer[]; unusable: UnusableServer[] } {
  const covered = (hostname: string) =>
    scope.grant.connections.some(
      (each) => each.header !== null && each.hosts.some((pattern) => hostMatches(pattern, hostname)),
    )
  const projects = isObject(host.projects) ? host.projects : {}
  const serversOf = (entry: unknown): Json => (isObject(entry) && isObject(entry.mcpServers) ? entry.mcpServers : {})
  const local = ownProjects(scope.cwd).map((dir) => serversOf(projects[dir]))
  const all: Json = { ...scope.borrowed, ...serversOf(host) }
  for (const servers of local.toReversed()) {
    Object.assign(all, servers)
  }
  const read = Object.entries(sandboxServers(all, scope.signedIn, scope.denied, covered)).map(([name, server]) =>
    codexServer(name, server),
  )
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en')
  return {
    servers: read.filter((each): each is CodexToolServer => 'transport' in each).toSorted(byName),
    unusable: read.filter((each): each is UnusableServer => 'reason' in each).toSorted(byName),
  }
}

/** The user's MCP servers the Codex agent starts with, under the grant its proxy applies. */
export async function codexToolServers(task: Task, grant: ProxyGrant, denied: ReadonlySet<string>) {
  const host = readHostConfig()
  const borrowed = await taskBorrowedServers(task, host)
  return codexServersOf(host, { cwd: task.cwd, borrowed, denied, signedIn: signedInServers(), grant })
}
