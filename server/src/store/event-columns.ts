import { setTimeout as sleep } from 'node:timers/promises'
import { storedColumns } from '../events/columns.js'
import type { Db } from '../pg.js'

const FILL_BATCH = 200
/** The fill rests at least this long between batches, and four times as long as a batch took. */
const FILL_REST_MS = 50
const FILL_REST_FACTOR = 4
const FILL_PROGRESS_MS = 60_000

/** Fills the event columns of the newest rows that have none yet; how many it filled. */
async function fillBatch(db: Db, batch: number): Promise<number> {
  const rows = await db<{ id: number; kind: string; payload: string }[]>`SELECT id, kind, payload
    FROM task_message WHERE runtime IS NULL ORDER BY id DESC LIMIT ${batch}`
  if (rows.length === 0) {
    return 0
  }
  const filled = rows.map((row) => ({ id: row.id, ...storedColumns(row.kind, row.payload, null) }))
  const column = <K extends keyof (typeof filled)[number]>(key: K) => filled.map((row) => row[key])
  await db`UPDATE task_message m SET runtime = f.runtime, thread = f.thread, event = f.event, agent = f.agent,
      turn_usd = f.turn_usd, turn_ms = f.turn_ms, turn_steps = f.turn_steps, turn_reply = f.turn_reply
    FROM unnest(${column('id')}::bigint[], ${column('runtime')}::text[], ${column('thread')}::text[],
      ${column('event')}::text[], ${column('agent')}::boolean[], ${column('turn_usd')}::float8[],
      ${column('turn_ms')}::float8[], ${column('turn_steps')}::integer[], ${column('turn_reply')}::boolean[])
      AS f(id, runtime, thread, event, agent, turn_usd, turn_ms, turn_steps, turn_reply)
    WHERE m.id = f.id AND m.runtime IS NULL`
  return rows.length
}

export interface FillOptions {
  batch?: number
  restMs?: number
  /** Hears the running count after the first batch that filled rows, then at most this often. */
  progressEveryMs?: number
  onProgress?: (filled: number) => void
}

/**
 * Fills the event columns of rows stored before they existed, or by a version of Seti that did
 * not fill them, newest first; how many rows it filled. Each batch is one short statement that
 * skips rows already filled, so a fill cut short anywhere resumes on the next start. Readers do
 * not wait for it: `eventFilters` reads a row the fill has not reached by its JSON.
 */
export async function fillEventColumns(db: Db, options: FillOptions = {}): Promise<number> {
  const { batch = FILL_BATCH, restMs = FILL_REST_MS, progressEveryMs = FILL_PROGRESS_MS, onProgress } = options
  let total = 0
  let reportedAt = Number.NEGATIVE_INFINITY
  for (;;) {
    const started = performance.now()
    const filled = await fillBatch(db, batch)
    if (filled === 0) {
      return total
    }
    total += filled
    if (onProgress && started - reportedAt >= progressEveryMs) {
      onProgress(total)
      reportedAt = started
    }
    await sleep(Math.max(restMs, (performance.now() - started) * FILL_REST_FACTOR))
  }
}
