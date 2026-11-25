import {
  RUNTIME_NAMES,
  STORED_RUNTIMES,
  type AgentCapabilities,
  type CapabilitiesSnapshot,
  type McpServer,
  type McpTransport,
  type RuntimeCapabilities,
  type StoredRuntime,
} from '@seti/shared'
import type { Capabilities } from './adapter.js'
import { adapterFor } from './registry.js'

/** What the agent's runtime declares; read it through the readers below. */
const declared = (runtime: StoredRuntime): Capabilities => adapterFor(runtime).capabilities

/** The runtime loads some of the user's MCP servers or claude.ai connectors. */
export const loadsUserServers = (runtime: StoredRuntime): boolean => declared(runtime).tools.userServers.length > 0

/** The runtime loads Seti's plugins. */
const loadsPlugins = (runtime: StoredRuntime): boolean => declared(runtime).tools.plugins

/** The runtimes that load Seti's plugins and the Claude Code plugins installed. */
export const pluginRuntimes = (): StoredRuntime[] => STORED_RUNTIMES.filter(loadsPlugins)

/**
 * The runtimes whose agents can use an MCP server: those that take its transport, and for a
 * server a plugin brings, only those that load plugins.
 */
export function serverRuntimes(transport: McpTransport, source: string | null): StoredRuntime[] {
  const plugin = source?.startsWith('plugin') === true
  return STORED_RUNTIMES.filter(
    (runtime) => declared(runtime).tools.userServers.includes(transport.type) && (!plugin || loadsPlugins(runtime)),
  )
}

/** A server with the runtimes that can use it; left as it is while its transport is unknown. */
const tagged = (server: McpServer): McpServer =>
  server.transport === null ? server : { ...server, runtimes: serverRuntimes(server.transport, server.source) }

/** The snapshot's servers, each with the runtimes that can use it. */
export const withRuntimes = (snapshot: CapabilitiesSnapshot): CapabilitiesSnapshot => ({
  ...snapshot,
  servers: snapshot.servers.map(tagged),
})

/** The runtime can run outside Seti's sandbox. */
export const runsUnsandboxed = (runtime: StoredRuntime): boolean => declared(runtime).sandbox.optional

/** The runtime takes a compaction rule. */
export const takesCompaction = (runtime: StoredRuntime): boolean => declared(runtime).compaction

/** The agent can hand work to background subagents of its own. */
export const hasSubagents = (runtime: StoredRuntime): boolean => declared(runtime).subagents

/** A side chat can fork the runtime's session. */
export const forksSideChat = (runtime: StoredRuntime): boolean => declared(runtime).session.fork !== 'none'

/** How the runtime runs dreams, or null where it keeps no memory. */
export const dreamsOf = (runtime: StoredRuntime) => declared(runtime).dream

/** A later turn can go back to an earlier prompt. */
const rewinds = (runtime: StoredRuntime): boolean => declared(runtime).rewind.conversation

/** The runtime's capabilities as the UI reads them. */
export const agentCapabilities = (runtime: StoredRuntime): AgentCapabilities => ({
  label: RUNTIME_NAMES[runtime],
  mcp_servers: loadsUserServers(runtime),
  mcp_transports: [...declared(runtime).tools.userServers],
  plugins: loadsPlugins(runtime),
  unsandboxed: runsUnsandboxed(runtime),
  compaction: takesCompaction(runtime),
  side_chat: forksSideChat(runtime),
  dreams: dreamsOf(runtime) !== null,
  rewind: rewinds(runtime),
})

/** Every stored runtime's capabilities. */
export const runtimeCapabilities = (): RuntimeCapabilities =>
  Object.fromEntries(STORED_RUNTIMES.map((runtime) => [runtime, agentCapabilities(runtime)])) as RuntimeCapabilities
