import { GEMINI_SETTINGS_DEFAULTS, type GeminiSettings } from '@seti/shared'
import { now, sql, type Db } from '../db.js'

/** The Gemini runtime's settings, the defaults until the user saves any. */
export const geminiSettings = {
  get: async (): Promise<GeminiSettings> => {
    const [row] = await sql<GeminiSettings[]>`SELECT enabled, evaluator_decides, default_model
      FROM gemini_settings WHERE id = 1`
    return row ?? GEMINI_SETTINGS_DEFAULTS
  },
  set: async (next: GeminiSettings, db: Db = sql): Promise<void> => {
    await db`INSERT INTO gemini_settings (id, enabled, evaluator_decides, default_model, updated_at)
      VALUES (1, ${next.enabled}, ${next.evaluator_decides}, ${next.default_model}, ${now()})
      ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, evaluator_decides = EXCLUDED.evaluator_decides,
        default_model = EXCLUDED.default_model, updated_at = EXCLUDED.updated_at`
  },
}
