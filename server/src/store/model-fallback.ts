import type { ModelFallback } from '@seti/shared'
import { sql } from '../db.js'

export const modelFallbacks = {
  /** Marks the task's session as running on a fallback model. */
  set: async (taskId: string, fallback: ModelFallback): Promise<void> => {
    await sql`UPDATE task SET model_fallback = ${JSON.stringify(fallback)} WHERE id = ${taskId}`
  },
  /** Ends the task's fallback; true when it had one. */
  clear: async (taskId: string): Promise<boolean> => {
    const rows = await sql`UPDATE task SET model_fallback = NULL
      WHERE id = ${taskId} AND model_fallback IS NOT NULL RETURNING id`
    return rows.length > 0
  },
  /** Whether the task already stored the fallback notice with this uuid, as a replay would repeat. */
  stored: async (taskId: string, uuid: string): Promise<boolean> => {
    const [row] = await sql<{ found: boolean }[]>`SELECT EXISTS (SELECT 1 FROM task_message
      WHERE task_id = ${taskId} AND kind = 'sdk' AND payload LIKE '%"model_refusal_fallback"%'
        AND payload::json ->> 'uuid' = ${uuid}) AS found`
    return row?.found === true
  },
}
