import type { MessageRow } from '@seti/shared'
import { sql, toMessage, type MessageRecord } from '../db.js'

/** Tool results are dropped, since they are large and the activity line only needs their ids. */
const LIGHT_PAYLOAD = sql`CASE WHEN m.kind = 'sdk' AND (m.payload::json ->> 'type') = 'user'
  THEN json_build_object('type', 'user', 'parent_tool_use_id', m.payload::json -> 'parent_tool_use_id',
    'message', json_build_object('role', 'user', 'content', '[]'::json))::text
  ELSE m.payload END`

export const eaContextStore = {
  /** The newest `limit` messages of the agent itself for each task, newest first. */
  recentActivity: async (taskIds: readonly string[], limit: number): Promise<Map<string, MessageRow[]>> => {
    const byTask = new Map<string, MessageRow[]>()
    if (taskIds.length === 0) {
      return byTask
    }
    const rows = await sql<MessageRecord[]>`SELECT r.* FROM unnest(${taskIds}::text[]) AS t(id)
      CROSS JOIN LATERAL (
        SELECT m.id, m.task_id, m.kind, ${LIGHT_PAYLOAD} AS payload, m.outward, m.created_at
        FROM task_message m
        WHERE m.task_id = t.id AND m.kind IN ('sdk', 'prompt', 'seti')
          AND (m.kind <> 'sdk' OR (m.payload::json ->> 'parent_tool_use_id') IS NULL)
        ORDER BY m.id DESC LIMIT ${limit}
      ) AS r`
    for (const row of rows.map(toMessage)) {
      byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), row])
    }
    return byTask
  },
  /** Updates waiting for each task's agent: undismissed ones after the last prompt it read. */
  waitingUpdates: async (): Promise<Map<string, number>> => {
    const rows = await sql<{ task_id: string; waiting: number }[]>`SELECT m.task_id, COUNT(*)::int AS waiting
      FROM task_message m
      WHERE m.kind = 'input' AND (m.payload::json ->> 'dismissed_at') IS NULL AND m.id > COALESCE((
        SELECT MAX(p.id) FROM task_message p
        WHERE p.task_id = m.task_id AND p.kind = 'prompt' AND (p.payload::json ->> 'text') NOT LIKE '/%'
          AND COALESCE(p.payload::json ->> 'queued', '') <> 'removed'
      ), 0)
      GROUP BY m.task_id`
    return new Map(rows.map((row) => [row.task_id, row.waiting]))
  },
  /** The newest turn ends, errors and PR updates across tasks, newest first. */
  notable: async (limit: number): Promise<MessageRow[]> =>
    (
      await sql<MessageRecord[]>`SELECT * FROM task_message
        WHERE kind IN ('input', 'seti') OR (kind = 'sdk' AND (payload::json ->> 'type') = 'result')
        ORDER BY id DESC LIMIT ${limit}`
    ).map(toMessage),
}
