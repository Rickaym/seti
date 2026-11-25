import type { PrOpinion, SecondOpinionSpend, StoredRuntime } from '@seti/shared'
import { now, sql, transaction } from '../db.js'

/** One second opinion as Seti keeps it: never its text, only who answered and what it cost. */
export interface SecondOpinionRow {
  taskId: string
  runtime: StoredRuntime
  model: string
  outcome: 'answered' | 'failed'
  costUsd: number | null
  estimated: boolean
  /** A light review of a pull request keeps its answer for the PR's row. */
  review?: { prUrl: string; answer: string } | null
}

export const secondOpinions = {
  /** Records one, adding its cost to the asking agent's. */
  record: async (row: SecondOpinionRow): Promise<void> => {
    await transaction(async (tx) => {
      const review = row.review ?? null
      await tx`INSERT INTO task_second_opinion
          (task_id, runtime, model, outcome, cost_usd, estimated, pr_url, answer, created_at)
        VALUES (${row.taskId}, ${row.runtime}, ${row.model}, ${row.outcome}, ${row.costUsd}, ${row.estimated},
          ${review?.prUrl ?? null}, ${review?.answer ?? null}, ${now()})`
      if (row.costUsd !== null && row.costUsd > 0) {
        await tx`UPDATE task SET cost_usd = cost_usd + ${row.costUsd} WHERE id = ${row.taskId}`
      }
    })
  },
  /** How many the agent asked since then. */
  countSince: async (taskId: string, since: string): Promise<number> => {
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM task_second_opinion
      WHERE task_id = ${taskId} AND created_at >= ${since}`
    return row?.count ?? 0
  },
  /** What the agent's second opinions cost, by the runtime that answered. */
  spend: async (taskId: string): Promise<SecondOpinionSpend[]> =>
    sql<SecondOpinionSpend[]>`SELECT runtime, count(*)::int AS count, coalesce(sum(cost_usd), 0) AS usd,
        bool_or(estimated) AS estimated
      FROM task_second_opinion WHERE task_id = ${taskId} GROUP BY runtime ORDER BY runtime`,
  /** The latest review of each of the agent's pull requests. */
  reviews: async (taskId: string): Promise<PrOpinion[]> =>
    sql<PrOpinion[]>`SELECT DISTINCT ON (pr_url) pr_url, runtime, model, created_at, answer
      FROM task_second_opinion WHERE task_id = ${taskId} AND pr_url IS NOT NULL AND answer IS NOT NULL
      ORDER BY pr_url, created_at DESC`,
  /** What every second opinion since then cost, in US dollars. */
  costSince: async (since: string): Promise<number> => {
    const [row] = await sql<{ usd: number | null }[]>`SELECT sum(cost_usd) AS usd
      FROM task_second_opinion WHERE created_at >= ${since}`
    return row?.usd ?? 0
  },
}
