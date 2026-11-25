import { eventsOf, type RuntimeEvent } from '@seti/shared'
import { tasks } from './db.js'
import { noteSessionInit, watchSessionMcp } from './mcp-session-status.js'
import { noteModelFallback, replayedFallback, settleModelFallback } from './model-fallback.js'
import type { ToolServerState } from './runtimes/adapter.js'
import { taskSessions } from './store/task-sessions.js'

/** Messages Seti does not store: a fallback notice a replayed stream repeats. */
export const unstored = async (taskId: string, m: unknown): Promise<boolean> => replayedFallback(taskId, m)

/**
 * Records a fallback notice, and on a session's start stores its id, mode and model, ends a
 * fallback that model shows is over, and follows how its MCP servers connect.
 */
export async function recordSessionStart(
  taskId: string,
  events: readonly RuntimeEvent[],
  read: () => Promise<ToolServerState[] | null>,
): Promise<void> {
  for (const fallback of eventsOf(events, 'model.changed')) {
    await noteModelFallback(taskId, fallback)
  }
  for (const started of eventsOf(events, 'session.started')) {
    await tasks.setSession(taskId, { sessionId: started.sessionId, permissionMode: started.mode, model: started.model })
    await taskSessions.record(taskId, started.sessionId)
    await settleModelFallback(taskId, started.model)
    await noteSessionInit(taskId, started.servers)
    void watchSessionMcp(taskId, read)
  }
}
