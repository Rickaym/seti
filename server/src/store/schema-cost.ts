import { TURN_COST_KEY } from '@seti/shared'
import { decodeArchive, type ChunkRef } from '../archive-codec.js'
import type { Db } from '../pg.js'
import { storedJson } from '../stored-rows.js'
import { countResult, type SessionTotal } from '../turn-cost.js'

/** The running total of the session each task's cost follows, which the next result counts from. */
export const TASK_COST_SESSION = `
CREATE TABLE task_cost_session (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  total_usd DOUBLE PRECISION NOT NULL
);
`

/** What each side chat answer cost, which the task's cost includes and today's cost counts. */
export const TASK_SIDE_CHAT_COST = `
CREATE TABLE task_side_chat_cost (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  cost_usd DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX task_side_chat_cost_created ON task_side_chat_cost (created_at);
`

const BATCH = 500

type Payload = Record<string, unknown>

interface TaskCount {
  cost: number
  last: SessionTotal | null
}

/** Counts a task's next stored result into its running count; the turn's cost, or null. */
function countInto(counts: Map<string, TaskCount>, taskId: string, payload: Payload): number | null {
  const count = counts.get(taskId) ?? { cost: 0, last: null }
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  const total = typeof payload.total_cost_usd === 'number' ? payload.total_cost_usd : 0
  const counted = countResult(count.last, sessionId, total)
  counts.set(taskId, { cost: count.cost + (counted.cost ?? 0), last: counted.last })
  return counted.cost
}

function parseResult(text: string): Payload | null {
  try {
    const payload: unknown = JSON.parse(text)
    if (typeof payload === 'object' && payload !== null && 'type' in payload && payload.type === 'result') {
      return { ...payload }
    }
  } catch {
    return null
  }
  return null
}

async function saveCost(tx: Db, taskId: string, count: TaskCount): Promise<void> {
  await tx`UPDATE task SET cost_usd = ${count.cost} WHERE id = ${taskId}`
  if (count.last !== null) {
    await tx`INSERT INTO task_cost_session (task_id, session_id, total_usd)
      VALUES (${taskId}, ${count.last.session_id}, ${count.last.total_usd})`
  }
}

/** Counts stored results a page at a time in id order and records each turn's cost on its result. */
async function recountLive(tx: Db): Promise<void> {
  const counts = new Map<string, TaskCount>()
  for (let after = 0; ;) {
    const rows = await tx<{ id: number; task_id: string; payload: string }[]>`SELECT id, task_id, payload
      FROM task_message WHERE kind = 'sdk' AND (payload::json ->> 'type') = 'result' AND id > ${after}
      ORDER BY id LIMIT ${BATCH}`
    const lastRow = rows.at(-1)
    if (lastRow === undefined) {
      break
    }
    const updates: { id: number; payload: string }[] = []
    for (const row of rows) {
      const payload = parseResult(row.payload)
      const cost = payload === null ? null : countInto(counts, row.task_id, payload)
      if (payload !== null && cost !== null) {
        updates.push({ id: row.id, payload: storedJson({ ...payload, [TURN_COST_KEY]: cost }) })
      }
    }
    await tx`UPDATE task_message m SET payload = u.payload
      FROM unnest(${updates.map((u) => u.id)}::bigint[], ${updates.map((u) => u.payload)}::text[]) AS u(id, payload)
      WHERE m.id = u.id`
    after = lastRow.id
  }
  for (const [taskId, count] of counts) {
    await saveCost(tx, taskId, count)
  }
}

/** Counts archived transcripts again, one at a time; one that fails its checksum keeps its cost. */
async function recountArchived(tx: Db): Promise<void> {
  const archived = await tx<{ task_id: string }[]>`SELECT task_id FROM task_archive ORDER BY task_id`
  for (const { task_id: taskId } of archived) {
    const [archive] = await tx<{ codec: string; blob: Buffer; chunks: string; sha256: string }[]>`SELECT codec,
        blob, chunks, sha256 FROM task_archive WHERE task_id = ${taskId}`
    const chunks = JSON.parse(archive?.chunks ?? '[]') as ChunkRef[]
    const rows = archive === undefined ? null : await decodeArchive({ ...archive, chunks }).catch(() => null)
    const counts = new Map<string, TaskCount>()
    for (const row of rows ?? []) {
      const payload = row.kind === 'sdk' && row.payload.includes('"result"') ? parseResult(row.payload) : null
      if (payload !== null) {
        countInto(counts, taskId, payload)
      }
    }
    const count = counts.get(taskId)
    if (count !== undefined) {
      await saveCost(tx, taskId, count)
    }
  }
}

/**
 * Seti added every result's running session total to its task, so a task's cost counted each
 * turn again with every later one. Tasks without stored results keep the cost they have.
 */
export async function recountTaskCosts(tx: Db): Promise<void> {
  await recountLive(tx)
  await recountArchived(tx)
}
