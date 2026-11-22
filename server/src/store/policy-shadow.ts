import { sql } from '../db.js'
import type { ShadowRecord } from '../policy/shadow.js'

/** Counts each compared call under its day and outcome. */
export const policyShadow = {
  count: async (record: ShadowRecord, day: string): Promise<void> => {
    await sql`INSERT INTO policy_shadow (day, kind, tool, mode, sandboxed, verdict, step, rule, runtime, result, calls)
      VALUES (${day}, ${record.kind}, ${record.tool}, ${record.mode}, ${record.sandboxed}, ${record.verdict},
        ${record.step}, ${record.rule}, ${record.runtime}, ${record.result}, 1)
      ON CONFLICT (day, kind, tool, mode, sandboxed, verdict, step, rule, runtime, result)
      DO UPDATE SET calls = policy_shadow.calls + 1`
  },
}
