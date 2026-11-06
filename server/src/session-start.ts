import type { McpServerStatus, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { tasks } from './db.js'
import { noteSessionInit, watchSessionMcp } from './mcp-session-status.js'

/** On a session's init, stores its id, mode and model and follows how its MCP servers connect. */
export async function recordSessionStart(
  taskId: string,
  m: SDKMessage,
  read: () => Promise<McpServerStatus[] | null>,
): Promise<void> {
  if (m.type !== 'system' || m.subtype !== 'init') {
    return
  }
  await tasks.setSession(taskId, { sessionId: m.session_id, permissionMode: m.permissionMode, model: m.model })
  await noteSessionInit(taskId, m.mcp_servers)
  void watchSessionMcp(taskId, read)
}
