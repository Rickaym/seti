import { now, rowFilter, sql, transaction } from '../db.js'
import { countResult, type SessionTotal } from '../turn-cost.js'

/**
 * Adds what a turn cost to its task, from the session's running total its end reports, and
 * returns that amount; null when not known.
 */
export async function recordTurnCost(taskId: string, sessionId: string, total: number): Promise<number | null> {
  return transaction(async (tx) => {
    const [task] = await tx`SELECT 1 FROM task WHERE id = ${taskId} FOR UPDATE`
    if (task === undefined) {
      return null
    }
    const [last] = await tx<SessionTotal[]>`SELECT session_id, total_usd FROM task_cost_session
      WHERE task_id = ${taskId}`
    const counted = countResult(last ?? null, sessionId, total)
    if (counted.last !== null && counted.last !== last) {
      await tx`INSERT INTO task_cost_session (task_id, session_id, total_usd)
        VALUES (${taskId}, ${counted.last.session_id}, ${counted.last.total_usd})
        ON CONFLICT (task_id) DO UPDATE SET session_id = EXCLUDED.session_id, total_usd = EXCLUDED.total_usd`
    }
    if (counted.cost !== null && counted.cost > 0) {
      await tx`UPDATE task SET cost_usd = cost_usd + ${counted.cost} WHERE id = ${taskId}`
    }
    return counted.cost
  })
}

/** Adds what a side chat answer cost to its task, and to the ledger today's cost reads. */
export async function addSideChatCost(taskId: string, usd: number): Promise<void> {
  await transaction(async (tx) => {
    const [task] = await tx`UPDATE task SET cost_usd = cost_usd + ${usd} WHERE id = ${taskId} RETURNING id`
    if (task !== undefined) {
      await tx`INSERT INTO task_side_chat_cost (task_id, cost_usd, created_at) VALUES (${taskId}, ${usd}, ${now()})`
    }
  })
}

/**
 * What every turn stored since `since` cost, with side chat answers, in US dollars; archived
 * transcripts are left out.
 */
export async function costSince(since: string): Promise<number> {
  const [row] = await sql<{ usd: number | null }[]>`SELECT
      sum(${rowFilter.turnUsd}) AS usd
    FROM task_message
    WHERE kind = 'sdk' AND ${rowFilter.turnEnd} AND created_at >= ${since}`
  const [side] = await sql<{ usd: number | null }[]>`SELECT sum(cost_usd) AS usd
    FROM task_side_chat_cost WHERE created_at >= ${since}`
  return (row?.usd ?? 0) + (side?.usd ?? 0)
}
