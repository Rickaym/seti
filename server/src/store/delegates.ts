import { sql } from '../db.js'

/** Agents other agents started, counted for the limits on starting more. */
export const delegates = {
  /** Running agents the caller started, or every agent-started agent's when the caller is null. */
  running: async (callerId: string | null): Promise<number> => {
    const [row] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM task
      WHERE delegated_by IS NOT NULL AND archived_at IS NULL AND status = 'running'
        AND (${callerId}::text IS NULL OR delegated_by = ${callerId})`
    return row?.count ?? 0
  },
  /** What the agents the caller started since `since` have cost so far, in dollars. */
  costSince: async (callerId: string, since: string): Promise<number> => {
    const [row] = await sql<{ cost: number | null }[]>`SELECT SUM(cost_usd)::float8 AS cost FROM task
      WHERE delegated_by = ${callerId} AND created_at >= ${since}`
    return row?.cost ?? 0
  },
}
