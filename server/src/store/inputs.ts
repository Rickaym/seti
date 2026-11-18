import type { DeliveryTiming, TaskInput } from '@seti/shared'
import { sql } from '../db.js'
import { readPayload } from '../stored-rows.js'

/** A prompt that reached the agent's queue and was not taken back before the agent read it. */
const SENT = sql`COALESCE(payload::json ->> 'queued', '') <> 'removed'`
const NOT_DISMISSED = sql`(payload::json ->> 'dismissed_at') IS NULL`

/** The id of the last prompt the agent read; updates after it wait for the agent. */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
const lastRead = (taskId: string) => sql`COALESCE((
  SELECT MAX(id) FROM task_message
  WHERE task_id = ${taskId} AND kind = 'prompt' AND (payload::json ->> 'text') NOT LIKE '/%' AND ${SENT}
), 0)`

/** An update that waits for the user's next message, as heldForMessage tells it. */
const HELD = sql`COALESCE(payload::json ->> 'delivery', '') = 'with_message'`

/** The id of the last prompt that took held updates: one somebody wrote, or a hand-over. */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
const lastHeldRead = (taskId: string) => sql`COALESCE((
  SELECT MAX(id) FROM task_message
  WHERE task_id = ${taskId} AND kind = 'prompt' AND (payload::json ->> 'text') NOT LIKE '/%' AND ${SENT}
    AND (COALESCE(payload::json ->> 'auto', 'false') = 'false' OR (payload::json ->> 'held') = 'true')
), 0)`

/** An undismissed update the agent has not read; a held one outlasts automatic turns. */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
const waiting = (taskId: string) => sql`task_id = ${taskId} AND kind = 'input' AND ${NOT_DISMISSED}
  AND id > CASE WHEN ${HELD} THEN ${lastHeldRead(taskId)} ELSE ${lastRead(taskId)} END`

export const taskInputs = {
  /** The newest `limit` waiting updates; without `held`, only those an automatic turn takes. */
  pending: async (taskId: string, limit: number, held = true): Promise<TaskInput[]> =>
    (
      await sql<{ id: number; payload: string }[]>`SELECT id, payload FROM (
        SELECT id, payload FROM task_message
        WHERE ${waiting(taskId)} ${held ? sql`` : sql`AND NOT ${HELD}`}
        ORDER BY id DESC LIMIT ${limit}
      ) AS pending ORDER BY id`
    ).flatMap((row) => readPayload({ task_id: taskId, id: row.id }, 'input', row.payload) ?? []),
  /**
   * How soon the waiting updates of these sources want a turn: now when any asks to join a
   * running turn, else after_turn; null when none may start a turn, as held ones never do.
   */
  waking: async (
    taskId: string,
    sources: readonly TaskInput['source'][],
  ): Promise<Exclude<DeliveryTiming, 'with_message'> | null> => {
    const [row] = await sql<
      { now: boolean | null }[]
    >`SELECT bool_or(COALESCE(payload::json ->> 'delivery', '') = 'now') AS now
      FROM task_message
      WHERE ${waiting(taskId)} AND NOT ${HELD} AND (payload::json ->> 'source') IN ${sql(sources)}`
    if (row === undefined || row.now === null) {
      return null
    }
    return row.now ? 'now' : 'after_turn'
  },
  /** Whether an update waits for the user's next message. */
  held: async (taskId: string): Promise<boolean> =>
    (await sql`SELECT 1 FROM task_message WHERE ${waiting(taskId)} AND ${HELD} LIMIT 1`).length > 0,
  /** Marks the waiting updates up to `upTo` dismissed; returns their ids, oldest first. */
  dismiss: async (taskId: string, upTo: number, at: string): Promise<number[]> =>
    (
      await sql<{ id: number }[]>`UPDATE task_message
        SET payload = (payload::jsonb || jsonb_build_object('dismissed_at', ${at}::text))::text
        WHERE ${waiting(taskId)} AND id <= ${upTo}
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
