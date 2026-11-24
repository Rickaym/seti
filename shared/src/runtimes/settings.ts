/**
 * Codex as Seti runs it, which only the user changes: off until they turn it on, the program
 * agents start, and whether Seti's permission rules answer a Codex agent's calls without them.
 */
export interface CodexSettings {
  enabled: boolean
  /** The absolute path of the `codex` program agents start; null until the user names it. */
  program: string | null
  /** On, an allow rule or Seti's read-only list answers a call; off, the user answers every one. */
  evaluator_decides: boolean
  /** The model and effort a new Codex agent starts with unless it picks its own. */
  default_model: string | null
  default_effort: string | null
}

export const CODEX_SETTINGS_DEFAULTS: CodexSettings = {
  enabled: false,
  program: null,
  evaluator_decides: false,
  default_model: null,
  default_effort: null,
}
