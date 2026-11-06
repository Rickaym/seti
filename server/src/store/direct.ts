import type { MessageRow } from '@seti/shared'
import { sql, toMessage, type MessageRecord } from '../db.js'

export const directRows = {
  /** The task's rows that may carry a direct message, for a check before its session is forked. */
  candidates: async (taskId: string): Promise<MessageRow[]> =>
    (
      await sql<MessageRecord[]>`SELECT * FROM task_message WHERE task_id = ${taskId}
        AND kind IN ('input', 'sdk')
        AND (payload LIKE '%direct%' OR payload LIKE '%post_team_chat%' OR payload LIKE '%to_kind%') ORDER BY id`
    ).map(toMessage),
}
