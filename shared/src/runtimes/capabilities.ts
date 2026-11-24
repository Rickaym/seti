import type { StoredRuntime } from './stored.js'

/**
 * What an agent's runtime can do where Seti would otherwise assume Claude Code, as its adapter
 * declares it. Each field is true for Claude Code; a control whose field is false is not offered.
 */
export interface AgentCapabilities {
  /** The runtime's name, as a control it lacks says "Not on <label>". */
  label: string
  /** It loads the user's MCP servers and claude.ai connectors; Seti's own tools reach any runtime. */
  mcp_servers: boolean
  /** It loads Seti's plugins. */
  plugins: boolean
  /** It can run outside Seti's sandbox. */
  unsandboxed: boolean
  /** It takes a compaction rule. */
  compaction: boolean
  /** A side chat can fork its session. */
  side_chat: boolean
  /** It keeps memory a dream can tidy. */
  dreams: boolean
  /** A later turn can go back to an earlier prompt. */
  rewind: boolean
}

/** Each runtime's capabilities, as the runtimes API serves them. */
export type RuntimeCapabilities = Record<StoredRuntime, AgentCapabilities>
