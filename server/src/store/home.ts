import { TURN_COST_KEY } from '@seti/shared'
import { sql } from '../db.js'

/** One agent's turns on one day in the reader's timezone. */
export interface TurnDay {
  task_id: string
  day: string
  turns: number
  cost_usd: number
  run_ms: number
}

/** A PR GitHub reported merged, for each agent it was linked to. */
export interface MergedLink {
  task_id: string
  pr_url: string
  /** When Seti's PR poll first saw it merged. */
  merged_at: string
  /** The day it merged in the reader's timezone. */
  day: string
}

/** An MCP server named in an agent's tool call, from one stored message. */
export interface McpCallRow {
  id: number
  task_id: string
  created_at: string
  server: string
}

/** An unescaped `"name":"mcp__` is a tool call's own name, never text quoted inside a string. */
const MCP_NAME = '"name":"mcp__'
const MCP_SERVER = '"name":"mcp__([^"]+?)__'

/** Postgres's timezone names, which `AT TIME ZONE` accepts. */
let zones: Promise<Set<string>> | null = null

export const homeStore = {
  /** Whether Postgres knows the zone; Seti counts days in UTC when it does not. */
  knowsZone: async (zone: string): Promise<boolean> => {
    zones ??= sql<{ name: string }[]>`SELECT name FROM pg_timezone_names`.then(
      (rows) => new Set(rows.map((row) => row.name)),
    )
    return (await zones).has(zone)
  },
  /**
   * Turns, cost and run time per agent and day, from turn results stored since `since`, reading
   * results from message `fromId` on through the result index.
   */
  turnDays: async (since: string, zone: string, fromId: number): Promise<TurnDay[]> => [
    ...(await sql<TurnDay[]>`SELECT task_id, to_char(created_at::timestamptz AT TIME ZONE ${zone}, 'YYYY-MM-DD') AS day,
        count(*)::int AS turns,
        COALESCE(sum((payload::json ->> ${TURN_COST_KEY})::float8), 0)::float8 AS cost_usd,
        COALESCE(sum((payload::json ->> 'duration_ms')::float8), 0)::float8 AS run_ms
      FROM task_message
      WHERE kind = 'sdk' AND (payload::json ->> 'type') = 'result' AND id >= ${fromId} AND created_at >= ${since}
      GROUP BY task_id, day ORDER BY task_id, day`),
  ],
  /** Changes when a message is stored or a PR is seen merging; counts are reused until then. */
  mark: async (): Promise<string> => {
    const [row] = await sql<{ message: number | null; merged: string | null; dismissed: number }[]>`SELECT
        (SELECT max(id)::float8 FROM task_message) AS message,
        (SELECT max(checked_at) FROM pr_watch WHERE open = 0) AS merged,
        (SELECT count(*)::int FROM task_pr_dismissed) AS dismissed`
    return JSON.stringify(row ?? null)
  },
  /**
   * Links to PRs that merged since `since`. A link the user dismissed before the PR merged does
   * not count; Seti dismisses a link itself only after it saw the merge.
   */
  mergedLinks: async (since: string, zone: string): Promise<MergedLink[]> => [
    ...(await sql<MergedLink[]>`SELECT DISTINCT p.task_id, p.pr_url, w.checked_at AS merged_at,
        to_char(w.checked_at::timestamptz AT TIME ZONE ${zone}, 'YYYY-MM-DD') AS day
      FROM pr_watch w
      JOIN (SELECT task_id, pr_url, NULL AS dismissed_at FROM task_pr
        UNION ALL SELECT task_id, pr_url, at FROM task_pr_dismissed) p ON p.pr_url = w.pr_url
      WHERE w.open = 0 AND (w.snapshot::json ->> 'state') = 'merged' AND w.checked_at >= ${since}
        AND (p.dismissed_at IS NULL OR p.dismissed_at >= w.checked_at)
      ORDER BY merged_at, p.pr_url, p.task_id`),
  ],
  /** The first message id stored since `since` across agents, read through each agent's index. */
  firstIdSince: async (since: string): Promise<number | null> => {
    const [row] = await sql<{ id: number | null }[]>`SELECT min(m.id)::float8 AS id FROM task t
      CROSS JOIN LATERAL (SELECT min(id) AS id FROM task_message
        WHERE task_id = t.id AND created_at >= ${since}) m`
    return row?.id ?? null
  },
  lastId: async (): Promise<number> => {
    const [row] = await sql<{ id: number | null }[]>`SELECT max(id)::float8 AS id FROM task_message`
    return row?.id ?? 0
  },
  /** MCP servers named by tool calls in messages with ids after `after`, up to `upto`. */
  mcpCalls: async (after: number, upto: number): Promise<McpCallRow[]> => [
    ...(await sql<McpCallRow[]>`SELECT m.id::float8 AS id, m.task_id, m.created_at, r[1] AS server
      FROM task_message m, regexp_matches(m.payload, ${MCP_SERVER}, 'g') AS r
      WHERE m.id > ${after} AND m.id <= ${upto} AND m.kind = 'sdk'
        AND (m.payload::json ->> 'type') = 'assistant' AND strpos(m.payload, ${MCP_NAME}) > 0
      ORDER BY m.id`),
  ],
}
