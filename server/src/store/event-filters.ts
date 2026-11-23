import { TURN_COST_KEY } from '@seti/shared'
import type postgres from 'postgres'
import type { Pool } from '../pg.js'

type Fragment = postgres.PendingQuery<postgres.Row[]>

/**
 * The filters readers put on `task_message` rows. A filled row is read by its event columns.
 * A row the background fill has not reached (no `runtime`) is read by its Claude JSON, as
 * the same filter read it before the columns existed, so readers see every row alike.
 * Columns are unqualified: use a filter where `task_message` is the innermost table.
 */
export function eventFilters(sql: Pool) {
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
  const either = (filled: Fragment, unfilled: Fragment) =>
    sql`((runtime IS NOT NULL AND ${filled}) OR (runtime IS NULL AND ${unfilled}))`
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
  const value = (filled: Fragment, unfilled: Fragment) =>
    sql`(CASE WHEN runtime IS NULL THEN ${unfilled} ELSE ${filled} END)`
  const parent = sql`(payload::json ->> 'parent_tool_use_id')`
  const type = sql`(payload::json ->> 'type')`
  return {
    /** Rows the task's own transcript shows: no subagent messages and no per-step progress reports. */
    ownRow: sql`(kind <> 'sdk' OR ${either(
      sql`thread = '' AND event IS DISTINCT FROM 'job.progress'`,
      sql`${parent} IS NULL AND (payload::json ->> 'subtype') IS DISTINCT FROM 'task_progress'`,
    )})`,
    /** Rows of the agent itself, not of a subagent. */
    ownThread: either(sql`thread = ''`, sql`${parent} IS NULL`),
    /** Rows of these subagent calls. */
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
    inThreads: (ids: readonly string[]) => either(sql`thread = ANY(${[...ids]})`, sql`${parent} = ANY(${[...ids]})`),
    /** Rows that hold the agent's text, thinking or tool calls. */
    agentRow: either(sql`agent`, sql`${type} = 'assistant'`),
    /** Rows that hold a tool call, among others. */
    callRow: either(sql`agent`, sql`strpos(payload, '"tool_use"') > 0`),
    /** Rows that hold a tool result, among others. */
    resultRow: either(sql`event = 'tool.ended'`, sql`strpos(payload, '"tool_result"') > 0`),
    /** Rows that end a turn. */
    turnEnd: either(sql`event = 'turn.ended'`, sql`${type} = 'result'`),
    /** Turn ends of a turn that took no step. */
    emptyTurnEnd: either(
      sql`event = 'turn.ended' AND turn_steps = 0`,
      sql`${type} = 'result'
      AND (payload::json ->> 'num_turns') = '0'`,
    ),
    /** Turn ends that carry the agent's reply. */
    turnReply: either(
      sql`turn_reply`,
      sql`(payload::json ->> 'subtype') = 'success'
      AND (payload::json ->> 'result') <> ''`,
    ),
    /** Rows that start a runtime session. */
    sessionStart: either(
      sql`event = 'session.started'`,
      sql`${type} = 'system'
      AND (payload::json ->> 'subtype') = 'init'`,
    ),
    /** Rows that report a change the agent published. */
    published: either(sql`event = 'change.published'`, sql`strpos(payload, '"subtype":"code_change_published"') > 0`),
    /** What a turn end says the turn cost, in US dollars. */
    turnUsd: value(sql`turn_usd`, sql`(payload::json ->> ${TURN_COST_KEY})::float8`),
    /** How long a turn end says the turn ran, in milliseconds. */
    turnMs: value(sql`turn_ms`, sql`(payload::json ->> 'duration_ms')::float8`),
  }
}
