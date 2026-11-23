import type { GrantConnection, ProxyGrant, Task } from '@seti/shared'
import { hostLoginKey } from './claude-logins.js'
import { codexKeyConnection } from './codex-key.js'
import { grantConnections, taskConnections } from './connection-egress.js'
import { ruleCaHosts } from './egress-rules.js'
import { connectorIds, taskDeniedServers } from './mcp-selection.js'
import type { RuntimeId } from './runtimes/adapter.js'
import { mcpHosts, mcpTargets, mcpTokens } from './sandbox-mcp.js'

/** The runtimes a sandbox is planned for; Codex joins RuntimeId when it is registered. */
export type PlannedRuntime = RuntimeId | 'codex'

/** A Codex agent's connections: its own, and its OpenAI key wherever that comes from. */
async function codexConnections(task: Task): Promise<GrantConnection[]> {
  const own = grantConnections(await taskConnections(task))
  const key = await codexKeyConnection(task)
  return key === null || own.some((each) => each.id === key.id) ? own : [...own, key]
}

/**
 * A Codex agent's grant: its connections and nothing of Claude's, so no Anthropic host, Claude
 * login, claude.ai connector or MCP sign-in of the host is in its reach.
 */
async function codexGrant(task: Task): Promise<ProxyGrant> {
  const connections = await codexConnections(task)
  return {
    login: null,
    anthropic: false,
    connections,
    mcp: [],
    deniedConnectors: [],
    caHosts: ruleCaHosts(connections),
  }
}

/** What the agent's egress proxy applies, read from the store, and the MCP servers it turned off. */
export async function proxyGrant(
  task: Task,
  runtime: PlannedRuntime = 'claude',
): Promise<{ grant: ProxyGrant; denied: Set<string> }> {
  const denied = new Set(await taskDeniedServers(task.id))
  if (runtime === 'codex') {
    return { grant: await codexGrant(task), denied }
  }
  const connections = grantConnections(await taskConnections(task))
  const grant: ProxyGrant = {
    login: hostLoginKey(),
    anthropic: true,
    connections,
    mcp: mcpTargets(mcpTokens, denied),
    deniedConnectors: connectorIds([...denied]),
    caHosts: [...new Set([...mcpHosts(), ...ruleCaHosts(connections)])],
  }
  return { grant, denied }
}
