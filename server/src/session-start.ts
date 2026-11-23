import type { McpServerStatus, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { tasks } from './db.js'
import { noteSessionInit, watchSessionMcp } from './mcp-session-status.js'
import { noteModelFallback, replayedFallback, settleModelFallback } from './model-fallback.js'

/** Messages Seti does not store: a fallback notice a replayed stream repeats. */
export const unstored = async (taskId: string, m: SDKMessage): Promise<boolean> => replayedFallback(taskId, m)

/**
 * Records a fallback notice, and on a session's init stores its id, mode and model, ends a
 * fallback that model shows is over, and follows how its MCP servers connect.
 */
export async function recordSessionStart(
  taskId: string,
  m: SDKMessage,
  read: () => Promise<McpServerStatus[] | null>,
): Promise<void> {
  await noteModelFallback(taskId, m)
  if (m.type !== 'system' || m.subtype !== 'init') {
    return
  }
  await tasks.setSession(taskId, { sessionId: m.session_id, permissionMode: m.permissionMode, model: m.model })
  await settleModelFallback(taskId, m.model)
  await noteSessionInit(taskId, m.mcp_servers)
  void watchSessionMcp(taskId, read)
}
