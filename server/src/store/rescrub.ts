import { setTimeout as sleep } from 'node:timers/promises'
import { sql } from '../db.js'
import { INPUT_CHARS } from '../permission-edits.js'
import type { Db } from '../pg.js'
import { redactCredentials, redactSecrets, scrubValue } from '../scrub.js'
import { storedJson } from '../stored-rows.js'
import { indexRuntimeRows, type RuntimeSearchRow } from './search-runtime.js'

const RESCRUB_BATCH = 500
const RESCRUB_PAUSE_MS = 25

/** What the sweep did in all its runs, by table; counts only, never a value. */
export interface RescrubCount {
  target: string
  checked: number
  changed: number
}

function parsed(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/** A stored transcript payload with what today's scrubber redacts; the same text when nothing is. */
export function scrubStoredPayload(payload: string): string {
  const read = parsed(payload)
  if (!read.ok) {
    return redactCredentials(payload)
  }
  const scrubbed = scrubValue(read.value)
  return scrubbed === read.value ? payload : storedJson(scrubbed)
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

/** A stored request input as `inputText` writes it today; a cut input is redacted as text. */
function scrubRequestInput(input: string): string {
  const read = parsed(input)
  if (!read.ok) {
    return redactCredentials(input)
  }
  const scrubbed = scrubValue(read.value)
  return scrubbed === read.value ? input : clip(JSON.stringify(scrubbed, null, 2), INPUT_CHARS)
}

const scrubLine = (text: string | null) => (text === null ? null : redactSecrets(text))

async function count(tx: Db, target: string, checked: number, changed: number): Promise<void> {
  await tx`UPDATE scrub_backfill SET checked = checked + ${checked}, changed = changed + ${changed}
    WHERE target = ${target}`
}

/** Re-scrubs one batch of transcript rows, newest first; false once none are left. */
async function messageBatch(batch: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [state] = await tx<{ below: number }[]>`SELECT below FROM scrub_backfill
      WHERE target = 'task_message' AND below IS NOT NULL FOR UPDATE`
    if (state === undefined) {
      return false
    }
    const rows = await tx<RuntimeSearchRow[]>`SELECT id, task_id, kind, created_at, payload, runtime FROM task_message
      WHERE id < ${state.below} ORDER BY id DESC LIMIT ${batch} FOR UPDATE`
    const low = rows.at(-1)?.id
    if (low === undefined) {
      await tx`UPDATE scrub_backfill SET below = NULL WHERE target = 'task_message'`
      return false
    }
    const changed = rows.flatMap((row) => {
      const payload = scrubStoredPayload(row.payload)
      return payload === row.payload ? [] : [{ ...row, payload }]
    })
    for (const row of changed) {
      await tx`UPDATE task_message SET payload = ${row.payload} WHERE id = ${row.id}`
    }
    await indexRuntimeRows(tx, changed)
    await tx`UPDATE scrub_backfill SET below = ${low} WHERE target = 'task_message'`
    await count(tx, 'task_message', rows.length, changed.length)
    return true
  })
}

interface RequestText {
  id: string
  summary: string
  description: string | null
  input: string
  reason: string | null
}

const sameRequest = (a: RequestText, b: RequestText) =>
  a.summary === b.summary && a.description === b.description && a.input === b.input && a.reason === b.reason

/** Re-scrubs one batch of permission requests in id order; false once none are left. */
async function requestBatch(batch: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [state] = await tx<{ after_id: string }[]>`SELECT after_id FROM scrub_backfill
      WHERE target = 'permission_request' AND after_id IS NOT NULL FOR UPDATE`
    if (state === undefined) {
      return false
    }
    const rows = await tx<RequestText[]>`SELECT id, summary, description, input, reason FROM permission_request
      WHERE id > ${state.after_id} ORDER BY id LIMIT ${batch} FOR UPDATE`
    const last = rows.at(-1)?.id
    if (last === undefined) {
      await tx`UPDATE scrub_backfill SET after_id = NULL WHERE target = 'permission_request'`
      return false
    }
    let changed = 0
    for (const row of rows) {
      const next = {
        ...row,
        summary: redactSecrets(row.summary),
        description: scrubLine(row.description),
        input: scrubRequestInput(row.input),
        reason: scrubLine(row.reason),
      }
      if (!sameRequest(row, next)) {
        await tx`UPDATE permission_request SET summary = ${next.summary}, description = ${next.description},
          input = ${next.input}, reason = ${next.reason} WHERE id = ${row.id}`
        changed += 1
      }
    }
    await tx`UPDATE scrub_backfill SET after_id = ${last} WHERE target = 'permission_request'`
    await count(tx, 'permission_request', rows.length, changed)
    return true
  })
}

/** The sweep's counts once both tables are done, and forgets them; null while it is not done. */
async function finish(): Promise<RescrubCount[] | null> {
  return sql.begin(async (tx) => {
    const rows = await tx<(RescrubCount & { open: boolean })[]>`SELECT target, checked::int AS checked,
      changed::int AS changed, (below IS NOT NULL OR after_id IS NOT NULL) AS open FROM scrub_backfill
      ORDER BY target DESC FOR UPDATE`
    if (rows.length === 0 || rows.some((row) => row.open)) {
      return null
    }
    await tx`DELETE FROM scrub_backfill`
    return rows.map(({ target, checked, changed }) => ({ target, checked, changed }))
  })
}

/**
 * Redacts session material older versions stored in transcripts and permission requests, in
 * short transactions that resume after a restart. The counts once done, null if nothing was left.
 */
export async function rescrubStoredRows(batch = RESCRUB_BATCH, pauseMs = RESCRUB_PAUSE_MS) {
  while (await messageBatch(batch)) {
    await sleep(pauseMs)
  }
  while (await requestBatch(batch)) {
    await sleep(pauseMs)
  }
  return finish()
}
