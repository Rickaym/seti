import { sql } from '../db.js'

/** A Codex agent's own messages of one kind of event, by the event columns its ingest filled. */
const OWN_CODEX = sql`kind = 'sdk' AND runtime = 'codex' AND thread = ''`

export const codexTurns = {
  /** The usage reports stored since the agent's own latest turn started, in order. */
  usage: async (taskId: string): Promise<string[]> =>
    (
      await sql<{ payload: string }[]>`SELECT payload FROM task_message
        WHERE task_id = ${taskId} AND kind = 'sdk' AND runtime = 'codex' AND event = 'usage'
          AND id > COALESCE((SELECT MAX(id) FROM task_message
            WHERE task_id = ${taskId} AND ${OWN_CODEX} AND event = 'turn.started'), 0)
        ORDER BY id`
    ).map((row) => row.payload),
  /** The agent's latest session start, which names the model its turns run on. */
  sessionStart: async (taskId: string): Promise<string | null> =>
    (
      await sql<{ payload: string }[]>`SELECT payload FROM task_message
        WHERE task_id = ${taskId} AND ${OWN_CODEX} AND event = 'session.started' ORDER BY id DESC LIMIT 1`
    ).at(0)?.payload ?? null,
}
