/** What a new agent runs on: Claude Code, or Codex with its model and effort. */
export interface RuntimePick {
  codex: boolean
  model: string | null
  effort: string | null
}

export const CLAUDE_PICK: RuntimePick = { codex: false, model: null, effort: null }

export const CODEX_HINT = 'Codex: sandboxed, asks before every command and edit.'

/** The request fields for a pick; Claude Code needs none. */
export function pickFields(pick: RuntimePick): { runtime?: 'codex'; model?: string; effort?: string } {
  if (!pick.codex) {
    return {}
  }
  return {
    runtime: 'codex',
    ...(pick.model === null ? {} : { model: pick.model }),
    ...(pick.effort === null ? {} : { effort: pick.effort }),
  }
}
