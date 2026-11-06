import type { SessionRestart, SetiControlLevel } from '@seti/shared'
import { sql } from '../db.js'

/** The id of the last prompt the agent read, or 0 before its first. */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
const lastTurn = (taskId: string) => sql`COALESCE((
  SELECT MAX(id) FROM task_message
  WHERE task_id = ${taskId} AND kind = 'prompt' AND (payload::json ->> 'text') NOT LIKE '/%'
    AND COALESCE(payload::json ->> 'queued', '') <> 'removed'
), 0)`

export const stoppedNotes = {
  /** Notes about processes the user stopped since the agent last read a message, oldest first. */
  sinceLastTurn: async (taskId: string): Promise<string[]> =>
    (
      await sql<{ note: string }[]>`SELECT payload::json ->> 'error' AS note FROM task_message
        WHERE task_id = ${taskId} AND kind = 'seti' AND (payload::json ->> 'stopped') = 'true'
          AND json_typeof(payload::json -> 'error') = 'string'
          AND id > ${lastTurn(taskId)}
        ORDER BY id`
    ).map((row) => row.note),
}

export const sessionRestarts = {
  /** How the user restarted the session since the agent last read a message, oldest first. */
  sinceLastTurn: async (taskId: string): Promise<SessionRestart[]> =>
    (
      await sql<{ session: SessionRestart }[]>`SELECT payload::json ->> 'session' AS session FROM task_message
        WHERE task_id = ${taskId} AND kind = 'seti' AND (payload::json ->> 'session') IN ('restarted', 'fresh')
          AND id > ${lastTurn(taskId)}
        ORDER BY id`
    ).map((row) => row.session),
}

export const setiControlNotes = {
  /**
   * The Seti control changes since the agent last read a message, oldest first, each with the
   * level it replaced; notes from before levels have none.
   */
  sinceLastTurn: async (taskId: string): Promise<{ was: SetiControlLevel | null }[]> =>
    (
      await sql<{ was: SetiControlLevel | null }[]>`SELECT payload::json ->> 'seti_control_was' AS was
        FROM task_message
        WHERE task_id = ${taskId} AND kind = 'seti' AND (payload::json ->> 'seti_control') IS NOT NULL
          AND id > ${lastTurn(taskId)}
        ORDER BY id`
    ).map((row) => ({ was: row.was })),
}
