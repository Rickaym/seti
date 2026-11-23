import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { EventOf } from '@seti/shared'

type TurnEnd = EventOf<'turn.ended'>

/** Separates the facts on one transcript line. */
export const DOT = ' \u00b7 '

const PERMISSION = new Map<string, string>([
  ['default', 'ask'],
  ['acceptEdits', 'accept edits'],
  ['bypassPermissions', 'bypass'],
  ['plan', 'plan'],
  ['dontAsk', "don't ask"],
  ['auto', 'auto'],
] satisfies [PermissionMode, string][])

/** A permission mode in a word or two. */
export const permissionLabel = (mode: string): string => PERMISSION.get(mode) ?? mode

/** The last folder of a path, or the path itself when it has none. */
export function lastSegment(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.at(-1) ?? path
}

const FAILURE: Record<NonNullable<TurnEnd['ending']>, string | null> = {
  error: 'error during execution',
  turn_limit: 'hit the step limit',
  budget_limit: 'hit the budget limit',
  retry_limit: 'no valid structured output',
  other: null,
}

/** How a turn ended, in plain words: "Turn done", "Turn failed: hit the step limit". */
export function turnOutcome(end: Pick<TurnEnd, 'status' | 'ending' | 'error'>, interrupted: boolean): string {
  if (interrupted) {
    return 'Turn interrupted'
  }
  if (end.status !== 'error') {
    return 'Turn done'
  }
  if (end.ending === undefined) {
    return 'Turn failed'
  }
  return `Turn failed: ${FAILURE[end.ending] ?? (end.error ?? '').replaceAll('_', ' ')}`
}

export const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`
