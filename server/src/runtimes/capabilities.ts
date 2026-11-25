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
import type { OneShot } from './one-shot.js'
import { adapterFor } from './registry.js'

/** What the agent's runtime declares; read it through the readers below. */
const declared = (runtime: StoredRuntime): Capabilities => adapterFor(runtime).capabilities

/** The runtime loads some of the user's MCP servers or claude.ai connectors. */
export const loadsUserServers = (runtime: StoredRuntime): boolean => declared(runtime).tools.userServers.length > 0

/** The runtime loads Seti's plugins. */
const loadsPlugins = (runtime: StoredRuntime): boolean => declared(runtime).tools.plugins

/** The runtimes that load Seti's plugins and the Claude Code plugins installed. */
export const pluginRuntimes = (): StoredRuntime[] => STORED_RUNTIMES.filter(loadsPlugins)

const TRANSPORT_WORDS: Record<McpTransport['type'], string> = {
  stdio: 'local (stdio) servers',
  sse: 'SSE servers',
  http: 'HTTP servers',
  sdk: 'in-process servers',
  'claudeai-proxy': 'claude.ai connectors',
}

/** One of the user's MCP servers as a runtime would load it. */
interface UserServer {
  name: string
  type: McpTransport['type']
  plugin: boolean
}

/** Why the runtime's agents cannot use one of the user's MCP servers, or null when they can. */
export function serverProblem(runtime: StoredRuntime, server: UserServer): string | null {
  const label = RUNTIME_NAMES[runtime]
  const { tools } = declared(runtime)
  if (server.plugin && !tools.plugins) {
    return `${label} agents load no plugins, so none of their servers.`
  }
  if (!tools.userServers.includes(server.type)) {
    return `${label} agents cannot use ${TRANSPORT_WORDS[server.type]}.`
  }
  if (tools.serverNames !== null && !tools.serverNames.pattern.test(server.name)) {
    return `${label} takes server names of ${tools.serverNames.rule}.`
  }
  return null
}

/** The runtimes whose agents can use one of the user's MCP servers. */
export const serverRuntimes = (server: UserServer): StoredRuntime[] =>
  STORED_RUNTIMES.filter((runtime) => serverProblem(runtime, server) === null)

/** A probed server whose transport is known, as a runtime would load it. */
const asUserServer = (server: McpServer, transport: McpTransport): UserServer => ({
  name: server.name,
  type: transport.type,
  plugin: server.source?.startsWith('plugin') === true,
})

/** Why the runtime's agents cannot use a probed server; null when they can or it is unknown how. */
export const probedServerProblem = (runtime: StoredRuntime, server: McpServer): string | null =>
  server.transport === null ? null : serverProblem(runtime, asUserServer(server, server.transport))

/** A server with the runtimes that can use it; left as it is while its transport is unknown. */
const tagged = (server: McpServer): McpServer =>
  server.transport === null ? server : { ...server, runtimes: serverRuntimes(asUserServer(server, server.transport)) }

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

/** How the runtime answers one question with no tools. */
export const oneShotFor = (runtime: StoredRuntime): OneShot => declared(runtime).oneShot

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
