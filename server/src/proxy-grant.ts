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

/**
 * The grant of an agent whose provider takes a connection's key: its connections and the MCP
 * sign-ins of the servers it did not turn off, and nothing else of Claude's: no Anthropic host,
 * Claude login or claude.ai connector.
 */
async function keyedGrant(task: Task, provider: ProviderId, denied: ReadonlySet<string>): Promise<ProxyGrant> {
  const connections = await keyedConnections(task, provider)
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
async function loginGrant(task: Task, denied: ReadonlySet<string>): Promise<ProxyGrant> {
  const connections = grantConnections(await taskConnections(task))
  return {
    login: hostLoginKey(),
    anthropic: true,
    connections,
    mcp: mcpTargets(mcpTokens, denied),
    deniedConnectors: connectorIds([...denied]),
    caHosts: [...new Set([...mcpHosts(), ...ruleCaHosts(connections)])],
  }
}

/** What the agent's egress proxy applies, read from the store, and the MCP servers it turned off. */
export async function proxyGrant(
  task: Task,
  runtime: RuntimeId = task.runtime,
): Promise<{ grant: ProxyGrant; denied: Set<string> }> {
  const denied = new Set(await taskDeniedServers(task.id))
  const provider = providerOf(runtime)
  const grant =
    PROVIDERS[provider].key === 'login' ? await loginGrant(task, denied) : await keyedGrant(task, provider, denied)
  return { grant, denied }
}
