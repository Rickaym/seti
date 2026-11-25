import {
  localServerNote,
  type AccessItem,
  type McpSelectionKind,
  type McpSessionState,
  type Task,
  type TaskMcpServer,
} from '@seti/shared'
import { sandboxed } from './aws-access.js'
import { ownProjects, readHostConfig, taskBorrowedServers } from './mcp-borrowed.js'
import { mcpCatalog, serverProblems, taskMcpServers } from './mcp-selection.js'
import { sessionMcp, sessionState } from './mcp-session-status.js'
import { tokenServers } from './mcp-sign-in.js'
import { loadsUserServers } from './runtimes/capabilities.js'
import { signedInServers } from './sandbox-mcp.js'

const MCP_KIND: Record<McpSelectionKind, string> = { config: 'configured', plugin: 'plugin', connector: 'claude.ai' }

type Json = Record<string, unknown>

const entryOf = (servers: unknown, name: string): unknown =>
  typeof servers === 'object' && servers !== null && name in servers ? (servers as Json)[name] : undefined

/** How each enabled server stands in the task's latest session; null before its first session. */
async function sessionStates(task: Task): Promise<(name: string) => McpSessionState | null> {
  const report = await sessionMcp(task.id)
  if (report === null) {
    return () => null
  }
  const host = readHostConfig()
  const projects = (host.projects ?? {}) as Json
  const borrowed = await taskBorrowedServers(task, host)
  const own = [host, ...ownProjects(task.cwd).map((key) => projects[key])].map((entry) =>
    typeof entry === 'object' && entry !== null && 'mcpServers' in entry ? entry.mcpServers : undefined,
  )
  const isSandboxed = await sandboxed(task)
  const signedIn = signedInServers()
  const stored = tokenServers()
  return (name) => {
    const config = [...own, borrowed].map((servers) => entryOf(servers, name)).find((entry) => entry !== undefined)
    const context = {
      config,
      sandboxed: isSandboxed,
      signedIn: signedIn.has(name),
      tokenStored: stored.has(name),
      inSetup: config !== undefined,
    }
    return sessionState(name, report, context)
  }
}

/** How the agent's latest session has an enabled server; null when off or before any session. */
export const taskMcpSession = async (task: Task, name: string): Promise<McpSessionState | null> =>
  (await mcpItems(task)).find((item) => item.id === name)?.session ?? null

function mcpDetail(server: TaskMcpServer): string {
  if (server.borrowed) {
    return localServerNote(server.local_to, server.default_enabled)
  }
  return server.kind === null ? 'not configured' : MCP_KIND[server.kind]
}

/** The user's MCP servers as access items, each with why the agent's runtime cannot use it. */
export async function mcpItems(task: Task | null): Promise<AccessItem[]> {
  const servers: TaskMcpServer[] =
    task === null
      ? (await mcpCatalog()).map((entry) => ({
          ...entry,
          choice: null,
          credential: null,
          enabled: entry.default_enabled,
          borrowed: entry.local_to.length > 0,
        }))
      : await taskMcpServers(task.id)
  const stateOf = task === null || !loadsUserServers(task.runtime) ? () => null : await sessionStates(task)
  const problem = task === null ? () => null : serverProblems(task.runtime)
  return servers.map((server) => {
    const unusable = problem(server.name)
    return {
      kind: 'mcp',
      id: server.name,
      name: server.name,
      detail: mcpDetail(server),
      default_enabled: server.default_enabled,
      credential: server.credential,
      override: server.choice,
      enabled: server.enabled,
      jump_for: [],
      missing_key: [],
      session: server.enabled && unusable === null ? stateOf(server.name) : null,
      unusable,
    }
  })
}
