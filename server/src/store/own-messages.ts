import { TRANSCRIPT_PAGE_MAX, type OwnMessageStep } from '@seti/shared'
import { sql } from '../db.js'

/** The user's own prompts as the transcript shows them: no automatic turns, resends or folds. */
const OWN_MESSAGE = sql`m.kind = 'prompt' AND (m.payload::json ->> 'auto') IS DISTINCT FROM 'true'
  AND (m.payload::json ->> 'retry') IS DISTINCT FROM 'true'
  AND NOT EXISTS (SELECT 1 FROM task_rewind r WHERE r.task_id = m.task_id
    AND m.id BETWEEN r.prompt_message_id AND r.last_message_id AND r.restore <> 'code' AND r.state <> 'refused')`

export type OwnCursor = { before: number; after?: undefined } | { after: number; before?: undefined }

async function nearest(taskId: string, cursor: OwnCursor): Promise<number | null> {
  const [row] =
    cursor.before === undefined
      ? await sql<{ id: number }[]>`SELECT m.id FROM task_message m
          WHERE m.task_id = ${taskId} AND m.id > ${cursor.after} AND ${OWN_MESSAGE} ORDER BY m.id LIMIT 1`
      : await sql<{ id: number }[]>`SELECT m.id FROM task_message m
          WHERE m.task_id = ${taskId} AND m.id < ${cursor.before} AND ${OWN_MESSAGE} ORDER BY m.id DESC LIMIT 1`
  return row?.id ?? null
}

/** Rows from the cursor to the message, it included, counted up to one past what a page loads. */
async function span(taskId: string, cursor: OwnCursor, id: number): Promise<number> {
  const [low, high] = cursor.before === undefined ? [cursor.after + 1, id] : [id, cursor.before - 1]
  const [row] = await sql<{ rows: number }[]>`SELECT count(*)::int AS rows FROM (SELECT 1 FROM task_message
    WHERE task_id = ${taskId} AND id BETWEEN ${low} AND ${high} LIMIT ${TRANSCRIPT_PAGE_MAX + 1}) AS gap`
  return row?.rows ?? 0
}

export const ownMessages = {
  /** The user's nearest own message before or after the cursor, and the page limit that loads it. */
  step: async (taskId: string, cursor: OwnCursor): Promise<OwnMessageStep> => {
    const id = await nearest(taskId, cursor)
    if (id === null) {
      return { id: null, reach: null }
    }
    const rows = await span(taskId, cursor, id)
    return { id, reach: rows > TRANSCRIPT_PAGE_MAX ? null : Math.max(rows, 1) }
  },
}
