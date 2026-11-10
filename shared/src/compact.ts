import { z } from 'zod'

export const COMPACT_WINDOW_MIN_K = 100
export const COMPACT_WINDOW_MAX_K = 1000
export const COMPACT_PCT_MIN = 10
export const COMPACT_PCT_MAX = 95
export const COMPACT_INSTRUCTIONS_MAX = 2000

/**
 * When Claude Code compacts an agent's conversation, through its own settings: `auto` is
 * autoCompactEnabled, `window_k` is autoCompactWindow in thousands of tokens (null leaves it to
 * Claude Code), `threshold_pct` is CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, and `instructions` go to
 * every compaction through a PreCompact hook.
 */
export const compactRuleInput = z
  .object({
    auto: z.boolean(),
    window_k: z
      .number()
      .int()
      .min(COMPACT_WINDOW_MIN_K, 'The context window is 100k to 1000k tokens')
      .max(COMPACT_WINDOW_MAX_K, 'The context window is 100k to 1000k tokens')
      .nullable(),
    threshold_pct: z
      .number()
      .int()
      .min(COMPACT_PCT_MIN, 'Compact at 10% to 95%')
      .max(COMPACT_PCT_MAX, 'Compact at 10% to 95%')
      .nullable(),
    instructions: z
      .string()
      .trim()
      .max(COMPACT_INSTRUCTIONS_MAX, 'Instructions are at most 2000 characters')
      .nullable(),
  })
  .refine((rule) => rule.threshold_pct === null || rule.window_k !== null, {
    message: 'Claude Code applies Compact at only to a context window you set',
    path: ['threshold_pct'],
  })

export type CompactRule = z.infer<typeof compactRuleInput>

/** What every summary keeps, in fixed sections, so an agent resumes knowing where it was. */
export const COMPACT_TEMPLATE = [
  'Write the summary in these sections, in this order, each kept short:',
  '- Objective: what the user asked for, in their words where the wording matters.',
  '- Requirements: constraints, preferences and rules the user set.',
  '- Decisions: what was decided and why, and approaches ruled out.',
  '- Work state: Completed; Active, with the exact next step of each; Blocked, and on what or whom.',
  '- Next move: the single next action.',
  '- Relevant files: at most 15 paths, each with why it matters.',
  '- Open questions: what still needs the user.',
  'Keep commands that worked and the exact names of branches, PRs, agents and tickets.',
  'Drop raw tool output and logs.',
].join('\n')

/** Compact automatically, where Claude Code picks, into the sections of `COMPACT_TEMPLATE`. */
export const COMPACT_DEFAULTS: CompactRule = {
  auto: true,
  window_k: null,
  threshold_pct: null,
  instructions: COMPACT_TEMPLATE,
}

/** A rule of its own for one agent, or null to go back to the default. */
export const taskCompactInput = z.object({ rule: compactRuleInput.nullable() })
export type TaskCompactInput = z.input<typeof taskCompactInput>

export interface CompactSettings {
  rule: CompactRule
  /** Null while the defaults apply. */
  updated_at: string | null
}

export interface TaskCompactRule {
  /** Null when the agent takes the default rule. */
  override: CompactRule | null
  effective: CompactRule
}

/** A rule in one line: Auto, 200k window at 70%, with instructions. */
export function compactLabel(rule: CompactRule): string {
  if (!rule.auto) {
    return rule.instructions === null ? 'Manual only' : 'Manual only, with instructions'
  }
  const window = rule.window_k === null ? '' : `, ${String(rule.window_k)}k window`
  const at = rule.threshold_pct === null ? '' : ` at ${String(rule.threshold_pct)}%`
  return `Auto${window}${at}${rule.instructions === null ? '' : ', with instructions'}`
}

/** Where a stored compact boundary keeps the context window it was measured against, in tokens. */
export const CONTEXT_WINDOW_KEY = 'seti_context_window'

/** A compact boundary with the context window Seti read for it. */
export type WithContextWindow<T> = T & Record<typeof CONTEXT_WINDOW_KEY, number>

/** How full the context was when it compacted, in percent; null without a stored window. */
export function compactedAtPct(boundary: object, preTokens: number): number | null {
  const window = CONTEXT_WINDOW_KEY in boundary ? boundary[CONTEXT_WINDOW_KEY] : null
  return typeof window === 'number' && window > 0 ? Math.round((preTokens / window) * 100) : null
}

/** " at 82%" for a boundary with a stored window, else nothing. */
export function compactedAt(boundary: object, preTokens: number): string {
  const pct = compactedAtPct(boundary, preTokens)
  return pct === null ? '' : ` at ${String(pct)}%`
}
