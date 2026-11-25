import type { StoredRuntime } from '@seti/shared'
import { now, sql, transaction } from '../db.js'

export const taskSessions = {
  /** Keeps the session the agent now has as its session on the runtime it runs on. */
  record: async (taskId: string, sessionId: string) => {
    await sql`INSERT INTO task_session (task_id, runtime, session_id, updated_at)
      SELECT id, runtime, ${sessionId}, ${now()} FROM task WHERE id = ${taskId}
      ON CONFLICT (task_id, runtime) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = EXCLUDED.updated_at`
  },
  /**
   * Moves the agent to the runtime with the model, or the runtime's default with null: its next
   * session resumes the one it last had there, whose id this returns, else starts anew.
   */
  moveTo: async (taskId: string, runtime: StoredRuntime, model: string | null): Promise<string | null> =>
    transaction(async (tx) => {
      const [kept] = await tx<{ session_id: string }[]>`SELECT session_id FROM task_session
        WHERE task_id = ${taskId} AND runtime = ${runtime}`
      const sessionId = kept?.session_id ?? null
      await tx`UPDATE task SET runtime = ${runtime}, requested_model = ${model}, requested_effort = NULL,
        model = NULL, session_id = ${sessionId}, updated_at = ${now()} WHERE id = ${taskId}`
      return sessionId
    }),
}
