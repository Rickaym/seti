import type { PolicyShadowDifference, PolicyShadowSummary } from '@seti/shared'
import { sql } from '../db.js'
import type { ShadowRecord } from '../policy/shadow.js'

/** The most differences a summary lists. */
const DIFFERENCES_MAX = 20

/** Counts each compared call under its day and outcome. */
export const policyShadow = {
  count: async (record: ShadowRecord, day: string): Promise<void> => {
    await sql`INSERT INTO policy_shadow (day, kind, tool, mode, sandboxed, slow, verdict, step, rule, runtime, result, calls)
      VALUES (${day}, ${record.kind}, ${record.tool}, ${record.mode}, ${record.sandboxed}, ${record.slow},
        ${record.verdict}, ${record.step}, ${record.rule}, ${record.runtime}, ${record.result}, 1)
      ON CONFLICT (day, kind, tool, mode, sandboxed, slow, verdict, step, rule, runtime, result)
      DO UPDATE SET calls = policy_shadow.calls + 1`
  },
  /** Counts a call Seti could not decide, with nothing about the call. */
  failed: async (day: string): Promise<void> => {
    await sql`INSERT INTO policy_shadow (day, kind, tool, mode, sandboxed, slow, verdict, step, rule, runtime, result, calls)
      VALUES (${day}, '', '', '', false, false, '', '', '', '', 'failed', 1)
      ON CONFLICT (day, kind, tool, mode, sandboxed, slow, verdict, step, rule, runtime, result)
      DO UPDATE SET calls = policy_shadow.calls + 1`
  },
  /** The counts since the day: by result, the slow ones, and the most frequent differences. */
  summary: async (since: string): Promise<PolicyShadowSummary> => {
    const results = await sql<{ result: string; calls: number; slow: number }[]>`SELECT result,
        SUM(calls)::int AS calls, COALESCE(SUM(calls) FILTER (WHERE slow), 0)::int AS slow
      FROM policy_shadow WHERE day >= ${since} GROUP BY result`
    const differences = await sql<PolicyShadowDifference[]>`SELECT result, kind, tool, mode, verdict, step, rule,
        runtime, SUM(calls)::int AS calls
      FROM policy_shadow WHERE day >= ${since} AND result IN ('looser', 'tighter')
      GROUP BY result, kind, tool, mode, verdict, step, rule, runtime
      ORDER BY calls DESC, result, kind, tool, rule LIMIT ${DIFFERENCES_MAX}`
    return {
      since,
      results: Object.fromEntries(results.map((row) => [row.result, row.calls])),
      slow: results.reduce((sum, row) => sum + row.slow, 0),
      differences: [...differences],
    }
  },
}
