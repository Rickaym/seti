import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import { MCP_STATUSES, mcpSignIn, type McpSessionState, type McpStatus } from '@seti/shared'
import { inBackground } from './background.js'
import { scrubUrls } from './capabilities.js'
import { hasClientId, tokenServers } from './mcp-sign-in.js'
import { cache } from './redis.js'
import { remoteServer, secretFree } from './sandbox-claude-json.js'
import { latestSessionInit, type SessionInit } from './store/sessions.js'
import { readPayload } from './stored-rows.js'
import { clearStalls } from './task-blocked.js'
import { publish } from './task-events.js'

/** One MCP server as a session reported it: no config values, only what the user may see. */
interface SessionServer {
  name: string
  status: McpStatus
  error: string | null
  transport: string | null
}

/** The MCP servers of a task's latest session and when it reported them. */
interface SessionMcp {
  at: string
  servers: SessionServer[]
  /** Servers the host held a token for when the session started; absent in older reports. */
  tokens?: string[]
}

const POLL_MS = 1000
const SETTLE_MS = 30_000
const TTL_S = 7 * 24 * 60 * 60

const known = new Map<string, SessionMcp>()

const cacheKey = (taskId: string) => `session-mcp:${taskId}`

const statusOf = (status: string): McpStatus => MCP_STATUSES.find((s) => s === status) ?? 'failed'

/** Keeps the report; a change in how the servers stand tells the task's open views. */
async function remember(taskId: string, value: SessionMcp): Promise<void> {
  const changed = JSON.stringify(known.get(taskId)?.servers) !== JSON.stringify(value.servers)
  known.set(taskId, value)
  await cache.set(cacheKey(taskId), value, TTL_S)
  if (changed) {
    publish(taskId, { type: 'mcp' })
  }
}

type Listed = readonly { name: string; status: string }[] | undefined

const brief = (servers: Listed): SessionServer[] =>
  (servers ?? []).map((s) => ({ name: s.name, status: statusOf(s.status), error: null, transport: null }))

/** Records the servers a session listed at its start, before any finished connecting. */
export async function noteSessionInit(taskId: string, servers: Listed): Promise<void> {
  await remember(taskId, { at: new Date().toISOString(), servers: brief(servers), tokens: [...tokenServers()] })
}

/** A sign-in finished: every agent's view reads its servers again, now against the new token. */
export function noteSignedIn(): void {
  for (const taskId of known.keys()) {
    publish(taskId, { type: 'mcp' })
  }
  inBackground('stalls', async () => clearStalls('mcp'))
}

const fromStatus = (s: McpServerStatus): SessionServer => ({
  name: s.name,
  status: s.status,
  error: s.error === undefined ? null : scrubUrls(s.error),
  transport: s.config?.type ?? (s.config === undefined ? null : 'stdio'),
})

const sleep = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/** Keeps a session's MCP status until none is pending or `settleMs` passed; null ends it. */
export async function watchSessionMcp(
  taskId: string,
  read: () => Promise<McpServerStatus[] | null>,
  timing = { pollMs: POLL_MS, settleMs: SETTLE_MS },
): Promise<void> {
  const deadline = Date.now() + timing.settleMs
  const tokens = [...tokenServers()]
  for (;;) {
    const servers = await read().catch(() => null)
    if (servers === null) {
      return
    }
    await remember(taskId, { at: new Date().toISOString(), servers: servers.map(fromStatus), tokens })
    if (!servers.some((s) => s.status === 'pending') || Date.now() >= deadline) {
      return
    }
    await sleep(timing.pollMs)
  }
}

function fromInit(row: SessionInit): SessionMcp {
  const m = readPayload(row, 'sdk', row.payload)
  const servers = m?.type === 'system' && m.subtype === 'init' ? m.mcp_servers : undefined
  return { at: row.at, servers: brief(servers) }
}

/** The task's latest session report: this process, the cache, else the recorded session start. */
export async function sessionMcp(taskId: string): Promise<SessionMcp | null> {
  const held = known.get(taskId) ?? (await cache.get<SessionMcp>(cacheKey(taskId)))
  if (held !== undefined) {
    return held
  }
  const init = await latestSessionInit(taskId)
  return init === undefined ? null : fromInit(init)
}

/** What Seti knows about a server's config, to explain why a session lacks it. */
interface ServerContext {
  /** Its config entry from the host, own or borrowed; undefined when Seti cannot see one. */
  config: unknown
  /** The task runs in the sandbox, which leaves out servers configured with keys. */
  sandboxed: boolean
  /** The host signed in to it with OAuth, so the sandbox proxy adds its token. */
  signedIn: boolean
  /** The host's credentials hold an access or refresh token for it. */
  tokenStored: boolean
  /** Its config is in the task's session setup now, so the next session has it. */
  inSetup: boolean
}

const SIGNED_IN_SINCE = 'Signed in after this session started; the next turn connects with it.'

const KEYS_REASON =
  'It is configured with keys, which stay outside the sandbox. Sign in to it with OAuth, or add a ' +
  "connection with a header for its host to the agent's credential."

/** A remote server the sandbox leaves out for its keys until the host signs in to it with OAuth. */
const keysKeptOut = (context: ServerContext) =>
  context.sandboxed && remoteServer(context.config) !== null && !secretFree(context.config) && !context.signedIn

function missingReason(name: string, context: ServerContext): string {
  if (keysKeptOut(context)) {
    return KEYS_REASON
  }
  if (context.inSetup) {
    return 'The session started without it; the next turn starts one that has it.'
  }
  if (name.startsWith('plugin:')) {
    return 'Its plugin is not loaded for this agent.'
  }
  return "The session's config does not have it, such as a server of another repo's .mcp.json."
}

const configType = (config: unknown) =>
  typeof config === 'object' && config !== null && 'type' in config && typeof config.type === 'string'
    ? config.type
    : null

function connectedReason(status: McpStatus, error: string | null, canSignIn: boolean): string | null {
  switch (status) {
    case 'connected':
      return null
    case 'needs-auth':
      return canSignIn ? 'Not signed in.' : 'Not signed in; run /mcp in claude on the host.'
    case 'pending':
      return 'Still connecting when the session last reported.'
    case 'disabled':
      return "Turned off in Claude Code's own settings."
    case 'failed':
      return error ?? 'It failed to start or connect.'
  }
}

/** How an enabled server stands in the task's latest session, with a plain reason when broken. */
export function sessionState(name: string, report: SessionMcp, context: ServerContext): McpSessionState {
  const server = report.servers.find((s) => s.name === name)
  if (server === undefined) {
    const signIn = keysKeptOut(context) ? 'required' : 'none'
    return { status: 'not_loaded', reason: missingReason(name, context), sign_in: signIn, at: report.at }
  }
  const { status, sign_in } = mcpSignIn({
    status: server.status,
    transport: server.transport ?? configType(context.config),
    clientId: hasClientId(context.config),
    tokenStored: context.tokenStored,
  })
  const signedInSince = context.tokenStored && report.tokens !== undefined && !report.tokens.includes(name)
  if (status !== 'connected' && signedInSince) {
    return { status: 'pending', reason: SIGNED_IN_SINCE, sign_in: 'none', at: report.at }
  }
  return { status, reason: connectedReason(status, server.error, sign_in !== 'none'), sign_in, at: report.at }
}
