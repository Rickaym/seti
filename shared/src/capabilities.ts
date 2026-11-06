import { z } from 'zod'

export const MCP_STATUSES = ['connected', 'needs-auth', 'failed', 'pending', 'disabled'] as const
export type McpStatus = (typeof MCP_STATUSES)[number]

/** The OAuth sign-in Seti offers: none, one the server needs, or a repeat over a stored token. */
export type McpSignIn = 'none' | 'required' | 'again'

export const capabilitiesScopeInput = z.object({
  repo_id: z.uuid().optional(),
})

export interface McpTool {
  name: string
  description: string
  read_only: boolean
  destructive: boolean
  open_world: boolean
}

/** Transport kind plus a URL (origin and path only) or a command name; never env, headers or args. */
export interface McpTransport {
  type: 'stdio' | 'sse' | 'http' | 'sdk' | 'claudeai-proxy'
  target: string | null
}

export interface McpServer {
  name: string
  status: McpStatus
  scope: string | null
  source: string | null
  transport: McpTransport | null
  /** A claude.ai connector's id, which its requests through Anthropic's MCP proxy carry. */
  connector_id: string | null
  server_version: string | null
  error: string | null
  tools: McpTool[]
  sign_in: McpSignIn
}

export interface CommandInfo {
  name: string
  description: string
  argument_hint: string
  aliases: string[]
}

export interface CommandGroup {
  prefix: string | null
  commands: CommandInfo[]
}

export interface SubagentInfo {
  name: string
  description: string
  model: string | null
}

export interface ModelEntry {
  value: string
  display_name: string
  description: string
}

export interface AccountSummary {
  email: string | null
  organization: string | null
  subscription_type: string | null
  api_provider: string | null
}

export interface CapabilitiesSnapshot {
  cwd: string
  probed_at: string
  duration_ms: number
  pending_timed_out: boolean
  account: AccountSummary
  servers: McpServer[]
  skill_groups: CommandGroup[]
  builtin_commands: CommandInfo[]
  subagents: SubagentInfo[]
  models: ModelEntry[]
}

const OAUTH_TRANSPORTS: ReadonlySet<string> = new Set(['http', 'sse', 'claudeai-proxy'])
const WEB_TRANSPORTS: ReadonlySet<string> = new Set(['http', 'sse'])

/** What Claude Code reports for a server and what the host holds for its OAuth sign-in. */
export interface SignInFacts {
  status: McpStatus
  transport: string | null
  /** Its config names an OAuth client ID. */
  clientId: boolean
  tokenStored: boolean
}

/** Status and sign-in to show: a client ID web server without a stored token needs a sign-in. */
export function mcpSignIn(facts: SignInFacts): { status: McpStatus; sign_in: McpSignIn } {
  const { status } = facts
  const transport = facts.transport ?? ''
  if (facts.clientId && WEB_TRANSPORTS.has(transport)) {
    if (!facts.tokenStored) {
      return { status: status === 'connected' ? 'needs-auth' : status, sign_in: 'required' }
    }
    return { status, sign_in: status === 'needs-auth' ? 'required' : 'again' }
  }
  return { status, sign_in: status === 'needs-auth' && OAUTH_TRANSPORTS.has(transport) ? 'required' : 'none' }
}

export interface CapabilitiesSummary {
  cwd: string
  probed_at: string
  servers: Record<McpStatus, number>
  tools: number
  skills: number
  subagents: number
}

export function summarizeCapabilities(snapshot: CapabilitiesSnapshot): CapabilitiesSummary {
  const servers = Object.fromEntries(MCP_STATUSES.map((status) => [status, 0])) as Record<McpStatus, number>
  for (const server of snapshot.servers) {
    servers[server.status] += 1
  }
  return {
    cwd: snapshot.cwd,
    probed_at: snapshot.probed_at,
    servers,
    tools: snapshot.servers.reduce((total, server) => total + server.tools.length, 0),
    skills: snapshot.skill_groups.reduce((total, group) => total + group.commands.length, 0),
    subagents: snapshot.subagents.length,
  }
}
