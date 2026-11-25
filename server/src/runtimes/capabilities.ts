import {
  RUNTIME_NAMES,
  STORED_RUNTIMES,
  type AgentCapabilities,
  type RuntimeCapabilities,
  type StoredRuntime,
} from '@seti/shared'
import type { Capabilities } from './adapter.js'
import type { OneShot } from './one-shot.js'
import { adapterFor } from './registry.js'

/** What the agent's runtime declares; read it through the readers below. */
const declared = (runtime: StoredRuntime): Capabilities => adapterFor(runtime).capabilities

/** The runtime loads the user's MCP servers and claude.ai connectors. */
export const loadsUserServers = (runtime: StoredRuntime): boolean => declared(runtime).tools.userServers

/** The runtime loads Seti's plugins. */
const loadsPlugins = (runtime: StoredRuntime): boolean => declared(runtime).tools.plugins

/** The runtime can run outside Seti's sandbox. */
export const runsUnsandboxed = (runtime: StoredRuntime): boolean => declared(runtime).sandbox.optional

/** The runtime takes a compaction rule. */
export const takesCompaction = (runtime: StoredRuntime): boolean => declared(runtime).compaction

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
