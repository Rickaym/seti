import type { TaskInput } from '@seti/shared'
import { sql } from '../db.js'
import { readPayload } from '../stored-rows.js'

/** A prompt that reached the agent's queue and was not taken back before the agent read it. */
const SENT = sql`COALESCE(payload::json ->> 'queued', '') <> 'removed'`
const NOT_DISMISSED = sql`(payload::json ->> 'dismissed_at') IS NULL`
/** Not a PR update Seti only recorded, which waits for nobody. */
const NOT_QUIET = sql`(payload::json ->> 'quiet') IS NULL`
/** A pass nobody waited for still goes to the agent with its next turn. */
const READABLE = sql`COALESCE(payload::json ->> 'quiet', 'nothing_pending') = 'nothing_pending'`

/** The id of the last prompt the agent read; updates after it wait for the agent. */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
const lastRead = (taskId: string) => sql`COALESCE((
  SELECT MAX(id) FROM task_message
  WHERE task_id = ${taskId} AND kind = 'prompt' AND (payload::json ->> 'text') NOT LIKE '/%' AND ${SENT}
), 0)`

/** The newest `limit` undismissed updates after lastRead: those that wait, or all the agent reads. */
async function newest(taskId: string, limit: number, readable: boolean): Promise<TaskInput[]> {
  const rows = await sql<{ id: number; payload: string }[]>`SELECT id, payload FROM (
      SELECT id, payload FROM task_message
      WHERE task_id = ${taskId} AND kind = 'input' AND ${NOT_DISMISSED}
        AND ${readable ? READABLE : NOT_QUIET} AND id > ${lastRead(taskId)}
      ORDER BY id DESC LIMIT ${limit}
    ) AS pending ORDER BY id`
  return rows.flatMap((row) => readPayload({ task_id: taskId, id: row.id }, 'input', row.payload) ?? [])
}

export const taskInputs = {
  /** The newest `limit` updates that wait for the agent: undismissed, not quiet, after lastRead. */
  pending: async (taskId: string, limit: number): Promise<TaskInput[]> => newest(taskId, limit, false),
  /** What the agent reads with its next turn: the waiting updates and the quiet ones that go along. */
  forTurn: async (taskId: string, limit: number): Promise<TaskInput[]> => newest(taskId, limit, true),
  /** Whether an undismissed update of these sources after lastRead may start a turn. */
  waking: async (taskId: string, sources: readonly TaskInput['source'][]): Promise<boolean> =>
    (
      await sql`SELECT 1 FROM task_message
        WHERE task_id = ${taskId} AND kind = 'input' AND ${NOT_DISMISSED} AND ${NOT_QUIET}
          AND (payload::json ->> 'source') IN ${sql(sources)}
          AND id > ${lastRead(taskId)}
        LIMIT 1`
    ).length > 0,
  /** Marks the waiting updates up to `upTo` dismissed; returns their ids, oldest first. */
  dismiss: async (taskId: string, upTo: number, at: string): Promise<number[]> =>
    (
      await sql<{ id: number }[]>`UPDATE task_message
        SET payload = (payload::jsonb || jsonb_build_object('dismissed_at', ${at}::text))::text
        WHERE task_id = ${taskId} AND kind = 'input' AND ${NOT_DISMISSED} AND ${NOT_QUIET}
          AND id <= ${upTo} AND id > ${lastRead(taskId)}
        RETURNING id`
    )
      .map((row) => row.id)
      .sort((a, b) => a - b),
  /** Start times of the newest automatic turns since `since` and since the user last wrote. */
  autoTurnsSince: async (taskId: string, since: string, limit: number): Promise<string[]> =>
    (
      await sql<{ created_at: string }[]>`SELECT created_at FROM task_message
        WHERE task_id = ${taskId} AND kind = 'prompt' AND (payload::json ->> 'auto') = 'true' AND ${SENT}
          AND created_at >= ${since}
          AND id > COALESCE((
            SELECT MAX(id) FROM task_message
            WHERE task_id = ${taskId} AND kind = 'prompt' AND COALESCE(payload::json ->> 'auto', 'false') = 'false'
              AND ${SENT}
          ), 0)
        ORDER BY id DESC LIMIT ${limit}`
    ).map((row) => row.created_at),
}
