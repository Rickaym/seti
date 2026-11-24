import { payloadEvents } from '@seti/shared'
import { searchTexts } from '../events/search-text.js'
import type { Db } from '../pg.js'

/** A stored row of a runtime other than Claude Code, which the search trigger leaves out. */
export interface RuntimeSearchRow {
  id: number
  task_id: string
  kind: string
  created_at: string
  payload: string
  runtime: string | null
}

const isNeutral = (row: RuntimeSearchRow) => row.kind === 'sdk' && row.runtime !== null && row.runtime !== 'claude'

/**
 * Indexes rows of runtimes other than Claude Code from their neutral events; the search trigger
 * indexes every other row from its JSON. Takes the payload as stored, credentials redacted.
 */
export async function indexRuntimeRows(db: Db, rows: readonly RuntimeSearchRow[]): Promise<void> {
  const indexed = rows.filter(isNeutral).flatMap((row) => {
    const texts = searchTexts(payloadEvents(row.payload, row.runtime))
    return texts === null
      ? []
      : [{ message_id: row.id, task_id: row.task_id, kind: row.kind, created_at: row.created_at, ...texts }]
  })
  if (indexed.length > 0) {
    await db`INSERT INTO message_search ${db(indexed, 'message_id', 'task_id', 'kind', 'created_at', 'body', 'talk')}
      ON CONFLICT (message_id) DO UPDATE SET body = EXCLUDED.body, talk = EXCLUDED.talk`
  }
}
