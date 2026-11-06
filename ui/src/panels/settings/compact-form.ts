import { compactRuleInput, type CompactRule } from '@seti/shared'

/** A compaction rule as typed; a blank window or percentage leaves it to Claude Code. */
export interface CompactForm {
  auto: boolean
  window: string
  pct: string
  instructions: string
}

const text = (value: number | null) => (value === null ? '' : String(value))

export const toCompactForm = (rule: CompactRule): CompactForm => ({
  auto: rule.auto,
  window: text(rule.window_k),
  pct: text(rule.threshold_pct),
  instructions: rule.instructions ?? '',
})

const wholeOrNull = (value: string): number | null | undefined => {
  const trimmed = value.trim()
  if (trimmed === '') {
    return null
  }
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) ? parsed : undefined
}

export function parseCompactForm(form: CompactForm): { rule: CompactRule } | { error: string } {
  const window = wholeOrNull(form.window)
  const pct = wholeOrNull(form.pct)
  if (window === undefined || pct === undefined) {
    return { error: 'Give the context window and Compact at as whole numbers' }
  }
  const instructions = form.instructions.trim()
  const result = compactRuleInput.safeParse({
    auto: form.auto,
    window_k: window,
    threshold_pct: pct,
    instructions: instructions === '' ? null : instructions,
  })
  return result.success ? { rule: result.data } : { error: result.error.issues[0]?.message ?? 'Not a valid rule' }
}

export const sameCompactForm = (a: CompactForm, b: CompactForm) =>
  a.auto === b.auto &&
  a.window.trim() === b.window.trim() &&
  a.pct.trim() === b.pct.trim() &&
  a.instructions.trim() === b.instructions.trim()
