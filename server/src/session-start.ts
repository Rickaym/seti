import type { McpServerStatus, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { tasks } from './db.js'
import { noteSessionInit, watchSessionMcp } from './mcp-session-status.js'
import { noteModelFallback, replayedFallback, settleModelFallback } from './model-fallback.js'

/** A message as Seti stores it: a session start without the tool, command and skill lists. */
export const storedForm = (m: SDKMessage): SDKMessage =>
  m.type === 'system' && m.subtype === 'init' ? { ...m, tools: [], slash_commands: [], skills: [] } : m

/** Messages Seti does not store: thinking token estimates, which nothing shows, and replays. */
export const unstored = async (taskId: string, m: SDKMessage): Promise<boolean> =>
  (m.type === 'system' && m.subtype === 'thinking_tokens') || (await replayedFallback(taskId, m))

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
