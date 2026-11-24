import { sql } from '../db.js'

/** The transcript lines that name a host the sandbox refused, one per task and host. */
export const refusedHostLines = {
  /** The task's line for the host, with the refusals it counts, or undefined before the first. */
  find: async (taskId: string, host: string): Promise<{ id: number; count: number } | undefined> => {
    const rows = await sql<{ id: number; count: string | null }[]>`SELECT id,
        payload::json ->> 'refused_count' AS count
      FROM task_message
      WHERE task_id = ${taskId} AND kind = 'seti' AND (payload::json ->> 'refused_host') = ${host}
      ORDER BY id LIMIT 1`
    const row = rows.at(0)
    return row === undefined ? undefined : { id: row.id, count: Number(row.count ?? 1) }
  },
  /** How many refused hosts the task's transcript names. */
  hosts: async (taskId: string): Promise<number> => {
    const rows = await sql<{ n: string }[]>`SELECT count(*) AS n FROM task_message
      WHERE task_id = ${taskId} AND kind = 'seti' AND (payload::json ->> 'refused_host') IS NOT NULL`
    return Number(rows.at(0)?.n ?? 0)
  },
  /** Sets the refusals a line counts. */
  count: async (taskId: string, id: number, count: number): Promise<void> => {
    await sql`UPDATE task_message
      SET payload = jsonb_set(payload::jsonb, '{refused_count}', to_jsonb(${count}::int))::text
      WHERE task_id = ${taskId} AND id = ${id}`
  },
}
