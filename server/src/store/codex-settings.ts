import { CODEX_SETTINGS_DEFAULTS, type CodexSettings } from '@seti/shared'
import { now, sql } from '../db.js'

/** The Codex runtime's settings, the defaults until the user saves any. */
export const codexSettings = {
  get: async (): Promise<CodexSettings> => {
    const [row] = await sql<CodexSettings[]>`SELECT enabled, program, evaluator_decides, default_model, default_effort
      FROM codex_settings WHERE id = 1`
    return row ?? CODEX_SETTINGS_DEFAULTS
  },
  set: async (next: CodexSettings): Promise<void> => {
    await sql`INSERT INTO codex_settings (id, enabled, program, evaluator_decides, default_model, default_effort,
        updated_at)
      VALUES (1, ${next.enabled}, ${next.program}, ${next.evaluator_decides}, ${next.default_model},
        ${next.default_effort}, ${now()})
      ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, program = EXCLUDED.program,
        evaluator_decides = EXCLUDED.evaluator_decides, default_model = EXCLUDED.default_model,
        default_effort = EXCLUDED.default_effort, updated_at = EXCLUDED.updated_at`
  },
}
