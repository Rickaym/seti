import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { TURN_COST_KEY, type WithTurnCost } from '@seti/shared'
import { now, sql, transaction } from '../db.js'
import { countResult, type SessionTotal } from '../turn-cost.js'

/** Adds what a result's turn cost to its task and returns that amount; null when not known. */
async function recordResult(taskId: string, sessionId: string, total: number): Promise<number | null> {
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

/** A result carries the session's running total; its turn's share is counted and stored with it. */
export async function withTurnCost(taskId: string, m: SDKMessage): Promise<SDKMessage> {
  if (m.type !== 'result') {
    return m
  }
  const cost = await recordResult(taskId, m.session_id, m.total_cost_usd)
  if (cost === null) {
    return m
  }
  const counted: WithTurnCost<SDKResultMessage> = { ...m, [TURN_COST_KEY]: cost }
  return counted
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
      sum((payload::json ->> ${TURN_COST_KEY})::float8) AS usd
    FROM task_message
    WHERE kind = 'sdk' AND (payload::json ->> 'type') = 'result' AND created_at >= ${since}`
  const [side] = await sql<{ usd: number | null }[]>`SELECT sum(cost_usd) AS usd
    FROM task_side_chat_cost WHERE created_at >= ${since}`
  return (row?.usd ?? 0) + (side?.usd ?? 0)
}
