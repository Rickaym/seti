import os from 'node:os'
import type { AuditDetail, AuditKind, McpConfigScope, McpServer, McpServerChange, McpServerRequest } from '@seti/shared'
import { taskMcpSession } from './agent-access.js'
import { audit } from './audit.js'
import { capabilityCache } from './capabilities.js'
import { repos, tasks } from './db.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { mcpAuth } from './mcp-auth.js'
import { serverDir } from './mcp-borrowed.js'
import { mcpConfig } from './mcp-config.js'
import { forgetRemovedMcpServer } from './mcp-presence.js'
import { withSignIn } from './mcp-sign-in.js'

/** The directory a scope's MCP config lives in: a registered repo's checkout, else the home. */
export async function scopeCwd(repoId: string | undefined): Promise<string> {
  if (repoId === undefined) {
    return os.homedir()
  }
  const repo = await repos.get(repoId)
  if (!repo) {
    throw new HttpError(404, 'Repo not found')
  }
  return repo.path
}

const findServer = (servers: McpServer[], name: string): McpServer => {
  const server = servers.find((s) => s.name === name)
  if (!server) {
    throw new HttpError(404, `No MCP server named ${name} in this scope`)
  }
  return server
}

/** The server in the asked scope, else in a probed directory that has it, with that directory. */
async function locate(name: string, repoId: string | undefined): Promise<{ server: McpServer; cwd: string }> {
  const cwd = await scopeCwd(repoId)
  const own = withSignIn(await capabilityCache.refresh(cwd)).servers.find((s) => s.name === name)
  if (own !== undefined) {
    return { server: own, cwd }
  }
  const elsewhere = capabilityCache.all().find((snapshot) => snapshot.servers.some((s) => s.name === name))
  if (elsewhere === undefined) {
    throw new HttpError(404, `No MCP server named ${name} in this scope`)
  }
  return {
    server: findServer(withSignIn(await capabilityCache.refresh(elsewhere.cwd)).servers, name),
    cwd: elsewhere.cwd,
  }
}

function assertCanSignIn(server: McpServer): void {
  if (server.status === 'connected' && server.sign_in === 'none') {
    throw new HttpError(409, `${server.name} is already connected`)
  }
  const type = server.transport?.type
  if (type !== 'http' && type !== 'sse' && type !== 'claudeai-proxy') {
    throw new HttpError(409, 'Only HTTP, SSE and claude.ai servers sign in with OAuth')
  }
}

/** Name, scope and transport only: never URLs, headers, env values or callback codes. */
export async function auditMcp(kind: AuditKind, server: string | null, summary: string, detail: AuditDetail = {}) {
  await audit.record({
    actor: 'user',
    kind,
    subject_type: 'mcp_server',
    subject_id: server,
    summary,
    detail: { server, ...detail },
  })
}

const failureText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Adds a server to agents' configuration; agents never do, since its host joins the sandbox. */
export async function addMcpServer(input: McpServerRequest): Promise<McpServerChange> {
  refuseAgent('add MCP servers')
  const change = await mcpConfig.add(input, await scopeCwd(input.repo_id))
  await auditMcp('mcp.server_added', input.name, `Added MCP server ${input.name} (${input.scope} scope)`, {
    scope: input.scope,
    transport: input.transport,
  })
  return change
}

export async function removeMcpServer(
  name: string,
  scope: McpConfigScope,
  repoId: string | undefined,
): Promise<McpServerChange> {
  const change = await mcpConfig.remove(name, scope, await scopeCwd(repoId))
  await auditMcp('mcp.server_removed', name, `Removed MCP server ${name} (${scope} scope)`, { scope })
  await forgetRemovedMcpServer(name)
  return change
}

interface SignInTarget {
  name: string
  cwd: string
  detail: AuditDetail
}

/** The server as the host probe sees it, which must offer a sign-in. */
async function hostTarget(name: string, repoId: string | undefined): Promise<SignInTarget> {
  const { server, cwd } = await locate(name, repoId)
  assertCanSignIn(server)
  return { name: server.name, cwd, detail: { scope: server.scope, transport: server.transport?.type ?? null } }
}

/**
 * The server as the agent's latest session has it, signed in where the agent's config comes from
 * so the token lands under the key its session reads; null when that session needs no sign-in.
 */
async function agentTarget(name: string, taskId: string): Promise<SignInTarget | null> {
  const task = await tasks.get(taskId)
  if (task === undefined) {
    throw new HttpError(404, 'Task not found')
  }
  const session = await taskMcpSession(task, name)
  if (session === null || session.sign_in === 'none') {
    return null
  }
  return { name, cwd: await serverDir(task, name), detail: { task: task.id, session: session.status } }
}

/**
 * Starts an OAuth sign-in to a server that offers one; the result holds the link to open. From an
 * agent's access, the agent's own session decides: the host probe may connect where it fails.
 */
export async function startMcpSignIn(name: string, repoId: string | undefined, taskId?: string) {
  const target = (taskId === undefined ? null : await agentTarget(name, taskId)) ?? (await hostTarget(name, repoId))
  try {
    const started = await mcpAuth.start(target.name, target.cwd)
    await auditMcp('mcp.signin_started', target.name, `Started sign-in to MCP server ${target.name}`, target.detail)
    return started
  } catch (e) {
    const summary = `Sign-in to ${target.name} failed: ${failureText(e)}`
    await auditMcp('mcp.signin_failed', target.name, summary, target.detail)
    throw e
  }
}

/** Cancels a sign-in that waits for its callback. */
export async function cancelMcpSignIn(sessionId: string): Promise<void> {
  const server = mcpAuth.serverOf(sessionId)
  if (!mcpAuth.cancel(sessionId)) {
    throw new HttpError(404, 'Sign-in session not found')
  }
  await auditMcp('mcp.signin_cancelled', server, `Cancelled sign-in to ${server ?? 'an MCP server'}`)
}

/** Probes the scope again and reports how the server connects now. */
export async function reconnectMcpServer(name: string, repoId: string | undefined): Promise<McpServer> {
  const snapshot = withSignIn(await capabilityCache.refresh(await scopeCwd(repoId)))
  const server = findServer(snapshot.servers, name)
  await auditMcp('mcp.server_reconnected', server.name, `Reconnected MCP server ${server.name}: ${server.status}`, {
    scope: server.scope,
    transport: server.transport?.type ?? null,
    status: server.status,
  })
  return server
}
