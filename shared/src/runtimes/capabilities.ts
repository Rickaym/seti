import { z } from 'zod'
import type { McpTransport } from '../capabilities.js'
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
  /** How it reaches the user's MCP servers; a server of another transport is not for it. */
  mcp_transports: McpTransport['type'][]
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

/** The capabilities a mod's command or view can need, each a field of AgentCapabilities. */
export const AGENT_CAPABILITY_NAMES = [
  'mcp_servers',
  'plugins',
  'unsandboxed',
  'compaction',
  'side_chat',
  'dreams',
  'rewind',
] as const satisfies readonly Exclude<keyof AgentCapabilities, 'label'>[]
export type AgentCapabilityName = (typeof AGENT_CAPABILITY_NAMES)[number]

/** What an agent's runtime must offer for a mod's command or view to show on it. */
export const capabilityNeeds = z.array(z.enum(AGENT_CAPABILITY_NAMES)).max(AGENT_CAPABILITY_NAMES.length).default([])

/** Whether the runtime has every capability named; true while its capabilities are unknown. */
export const meetsNeeds = (caps: AgentCapabilities | null, needs: readonly AgentCapabilityName[]): boolean =>
  caps === null || needs.every((need) => caps[need])

/** Each runtime's capabilities, as the runtimes API serves them. */
export type RuntimeCapabilities = Record<StoredRuntime, AgentCapabilities>
