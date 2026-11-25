import { storedRuntime, type SetiControlLevel, type StoredRuntime } from '@seti/shared'
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
  /** Whether the user restarted the session since the agent last read a message. */
  sinceLastTurn: async (taskId: string): Promise<boolean> =>
    (
      await sql`SELECT 1 FROM task_message
        WHERE task_id = ${taskId} AND kind = 'seti' AND (payload::json ->> 'session') = 'restarted'
          AND id > ${lastTurn(taskId)}
        LIMIT 1`
    ).length > 0,
}

export const continuedNotes = {
  /** The runtime the agent left in its latest move since it last read a message; null for none. */
  sinceLastTurn: async (taskId: string): Promise<StoredRuntime | null> => {
    const [row] = await sql<{ was: string | null }[]>`SELECT payload::json ->> 'runtime_was' AS was
      FROM task_message
      WHERE task_id = ${taskId} AND kind = 'seti' AND (payload::json ->> 'session') = 'continued'
        AND id > ${lastTurn(taskId)}
      ORDER BY id DESC LIMIT 1`
    return row === undefined ? null : storedRuntime(row.was)
  },
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
