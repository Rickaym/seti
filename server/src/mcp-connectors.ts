import type { McpConnectorList } from '@seti/shared'
import { commonConnectors } from './mcp-connector-list.js'
import { mcpRegistry } from './mcp-registry.js'

const MIN_SEARCH = 2

/** Common connectors matching the query, and the MCP Registry's once the query is long enough. */
export async function listConnectors(query: string, cursor?: string): Promise<McpConnectorList> {
  const common = cursor === undefined ? commonConnectors(query) : []
  if (query.length < MIN_SEARCH) {
    return { common, registry: [], next_cursor: null, registry_error: null }
  }
  try {
    const found = await mcpRegistry.search(query, cursor)
    return { common, registry: found.servers, next_cursor: found.next_cursor, registry_error: null }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { common, registry: [], next_cursor: null, registry_error: `The MCP Registry is unreachable: ${reason}` }
  }
}
