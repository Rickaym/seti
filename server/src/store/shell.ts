import type { ShellResult } from '@seti/shared'
import { sql } from '../db.js'
import { readPayload } from '../stored-rows.js'

export const shellRuns = {
  /** The newest `limit` shell runs after the last prompt the agent read as a message, oldest first. */
  sinceLastTurn: async (taskId: string, limit: number): Promise<ShellResult[]> =>
    (
      await sql<{ id: number; payload: string }[]>`SELECT id, payload FROM (
        SELECT id, payload FROM task_message
        WHERE task_id = ${taskId} AND kind = 'shell' AND id > COALESCE((
          SELECT MAX(id) FROM task_message
          WHERE task_id = ${taskId} AND kind = 'prompt' AND (payload::json ->> 'text') NOT LIKE '/%'
            AND COALESCE(payload::json ->> 'queued', '') <> 'removed'
        ), 0)
        ORDER BY id DESC LIMIT ${limit}
      ) AS runs ORDER BY id`
    ).flatMap((row) => readPayload({ task_id: taskId, id: row.id }, 'shell', row.payload) ?? []),
}
