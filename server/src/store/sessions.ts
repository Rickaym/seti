import { sql } from '../db.js'

export const sessionLinks = {
  known: async (): Promise<Set<string>> =>
    new Set(
      (
        await sql<{ id: string }[]>`SELECT session_id AS id FROM task WHERE session_id IS NOT NULL
          UNION SELECT source_session_id FROM task WHERE source_session_id IS NOT NULL`
      ).map((row) => row.id),
    ),
}

export interface SessionInit {
  id: number
  task_id: string
  at: string
  payload: string
}

/** The latest session start of a task, as recorded: its time and its init message. */
export async function latestSessionInit(taskId: string): Promise<SessionInit | undefined> {
  const rows = await sql<SessionInit[]>`SELECT id, task_id, created_at AS at, payload FROM task_message
    WHERE task_id = ${taskId} AND kind = 'sdk' AND payload::json ->> 'type' = 'system'
      AND payload::json ->> 'subtype' = 'init'
    ORDER BY id DESC LIMIT 1`
  return rows[0]
}
