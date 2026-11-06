import { COMPACT_DEFAULTS, type CompactRule } from '@seti/shared'
import { now, sql } from '../db.js'

interface RuleRow {
  auto: boolean
  window_k: number | null
  threshold_pct: number | null
  instructions: string | null
  updated_at: string
}

const toRule = (row: RuleRow): CompactRule => ({
  auto: row.auto,
  window_k: row.window_k,
  threshold_pct: row.threshold_pct,
  instructions: row.instructions,
})

/** Blank instructions are none. */
function instructionsOf(rule: CompactRule): string | null {
  const text = rule.instructions?.trim() ?? ''
  return text === '' ? null : text
}

export const compactSettings = {
  /** The default rule of every agent and when it was saved; null while Claude Code's own applies. */
  get: async (): Promise<{ rule: CompactRule; updated_at: string | null }> => {
    const [row] = await sql<RuleRow[]>`SELECT auto, window_k, threshold_pct, instructions, updated_at
      FROM compact_settings WHERE id = 1`
    return row === undefined
      ? { rule: COMPACT_DEFAULTS, updated_at: null }
      : { rule: toRule(row), updated_at: row.updated_at }
  },
  set: async (rule: CompactRule): Promise<void> => {
    await sql`INSERT INTO compact_settings (id, auto, window_k, threshold_pct, instructions, updated_at)
      VALUES (1, ${rule.auto}, ${rule.window_k}, ${rule.threshold_pct}, ${instructionsOf(rule)}, ${now()})
      ON CONFLICT (id) DO UPDATE SET auto = excluded.auto, window_k = excluded.window_k,
        threshold_pct = excluded.threshold_pct, instructions = excluded.instructions,
        updated_at = excluded.updated_at`
  },
}

export const taskCompactRules = {
  get: async (taskId: string): Promise<CompactRule | null> => {
    const [row] = await sql<RuleRow[]>`SELECT auto, window_k, threshold_pct, instructions, updated_at
      FROM task_compact WHERE task_id = ${taskId}`
    return row === undefined ? null : toRule(row)
  },
  /** Gives the task a rule of its own, or with null takes it back to the default. */
  set: async (taskId: string, rule: CompactRule | null): Promise<void> => {
    if (rule === null) {
      await sql`DELETE FROM task_compact WHERE task_id = ${taskId}`
      return
    }
    await sql`INSERT INTO task_compact (task_id, auto, window_k, threshold_pct, instructions, updated_at)
      VALUES (${taskId}, ${rule.auto}, ${rule.window_k}, ${rule.threshold_pct}, ${instructionsOf(rule)}, ${now()})
      ON CONFLICT (task_id) DO UPDATE SET auto = excluded.auto, window_k = excluded.window_k,
        threshold_pct = excluded.threshold_pct, instructions = excluded.instructions,
        updated_at = excluded.updated_at`
  },
}
