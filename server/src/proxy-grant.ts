import { PROVIDERS, providerOf, type GrantConnection, type ProviderId, type ProxyGrant, type Task } from '@seti/shared'
import { hostLoginKey } from './claude-logins.js'
import { grantConnections, taskConnections } from './connection-egress.js'
import { ruleCaHosts } from './egress-rules.js'
import { connectorIds, taskDeniedServers } from './mcp-selection.js'
import { providerKeyConnection } from './provider-key.js'
import type { RuntimeId } from './runtimes/adapter.js'
import { mcpHosts, mcpTargets, mcpTokens } from './sandbox-mcp.js'

/** An agent's connections: its own, and its key for the provider wherever that comes from. */
async function keyedConnections(task: Task, provider: ProviderId): Promise<GrantConnection[]> {
  const own = grantConnections(await taskConnections(task))
  const key = await providerKeyConnection(task, provider)
  return key === null || own.some((each) => each.id === key.id) ? own : [...own, key]
}

/** The grant of an agent whose provider takes a connection's key: nothing of Claude's. */
function keyedGrant(connections: GrantConnection[], denied: ReadonlySet<string>): ProxyGrant {
  return {
    login: null,
    anthropic: false,
    connections,
    mcp: mcpTargets(mcpTokens, denied),
    deniedConnectors: [],
    caHosts: [...new Set([...mcpHosts(), ...ruleCaHosts(connections)])],
  }
}

/** The grant of an agent signed in with the host's Claude login: Anthropic and its connectors. */
function loginGrant(connections: GrantConnection[], denied: ReadonlySet<string>): ProxyGrant {
  return {
    login: hostLoginKey(),
    anthropic: true,
    connections,
    mcp: mcpTargets(mcpTokens, denied),
    deniedConnectors: connectorIds([...denied]),
    caHosts: [...new Set([...mcpHosts(), ...ruleCaHosts(connections)])],
  }
}

/** The connections the agent's proxy swaps on this runtime, read from the store. */
export async function grantedConnections(task: Task, runtime: RuntimeId = task.runtime): Promise<GrantConnection[]> {
  const provider = providerOf(runtime)
  return PROVIDERS[provider].key === 'login'
    ? grantConnections(await taskConnections(task))
    : keyedConnections(task, provider)
}

/** What the agent's egress proxy applies, read from the store, and the MCP servers it turned off. */
export async function proxyGrant(
  task: Task,
  runtime: RuntimeId = task.runtime,
): Promise<{ grant: ProxyGrant; denied: Set<string> }> {
  const denied = new Set(await taskDeniedServers(task.id))
  const connections = await grantedConnections(task, runtime)
  const login = PROVIDERS[providerOf(runtime)].key === 'login'
  return { grant: login ? loginGrant(connections, denied) : keyedGrant(connections, denied), denied }
}
