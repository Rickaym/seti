import type { ProxyGrant, Task } from '@seti/shared'
import { hostLoginKey } from './claude-logins.js'
import { grantConnections, taskConnections } from './connection-egress.js'
import { ruleCaHosts } from './egress-rules.js'
import { connectorIds, taskDeniedServers } from './mcp-selection.js'
import { mcpHosts, mcpTargets, mcpTokens } from './sandbox-mcp.js'

/** What the agent's egress proxy applies, read from the store, and the MCP servers it turned off. */
export async function proxyGrant(task: Task): Promise<{ grant: ProxyGrant; denied: Set<string> }> {
  const denied = new Set(await taskDeniedServers(task.id))
  const connections = grantConnections(await taskConnections(task))
  const grant: ProxyGrant = {
    login: hostLoginKey(),
    connections,
    mcp: mcpTargets(mcpTokens, denied),
    deniedConnectors: connectorIds([...denied]),
    caHosts: [...new Set([...mcpHosts(), ...ruleCaHosts(connections)])],
  }
  return { grant, denied }
}
