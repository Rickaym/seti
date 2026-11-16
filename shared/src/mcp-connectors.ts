import { z } from 'zod'
import type { McpAddTransport } from './mcp.js'

/** A header of a remote server or an environment variable of a local one, named but never filled. */
export interface McpConnectorField {
  key: string
  description: string
  required: boolean
  secret: boolean
  /** A non-secret default the server documents; empty otherwise. */
  value: string
}

/** How a connector signs in when the server offers no dynamic client registration. */
export interface McpConnectorOAuth {
  /** The user registers their own OAuth app and enters its client ID and secret. */
  own_client: boolean
  callback_port: number | null
}

/** A server ready to add: a common connector Seti lists, or an entry of the MCP Registry. */
export interface McpConnector {
  id: string
  /** The config name it gets unless the user changes it. */
  name: string
  title: string
  description: string
  source: 'common' | 'registry'
  transport: McpAddTransport
  url: string
  command: string
  args: string[]
  fields: McpConnectorField[]
  oauth: McpConnectorOAuth | null
  /** A Claude Code plugin, such as slack@claude-plugins-official, that brings the server instead. */
  plugin: string | null
  homepage: string | null
  note: string
}

export interface McpConnectorList {
  common: McpConnector[]
  registry: McpConnector[]
  next_cursor: string | null
  /** Why the MCP Registry could not be searched; the common connectors still list. */
  registry_error: string | null
}

export const mcpConnectorQuery = z.object({
  q: z.string().trim().max(100).default(''),
  cursor: z.string().max(300).optional(),
})
export type McpConnectorQuery = z.input<typeof mcpConnectorQuery>
