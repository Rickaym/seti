import type { PermissionMode, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

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

const FAILURE = new Map<string, string>([
  ['error_during_execution', 'error during execution'],
  ['error_max_turns', 'hit the step limit'],
  ['error_max_budget_usd', 'hit the budget limit'],
  ['error_max_structured_output_retries', 'no valid structured output'],
] satisfies [SDKResultMessage['subtype'], string][])

/** How a turn ended, in plain words: "Turn done", "Turn failed: hit the step limit". */
export function turnOutcome(message: Pick<SDKResultMessage, 'subtype' | 'is_error'>, interrupted: boolean): string {
  if (interrupted) {
    return 'Turn interrupted'
  }
  if (!message.is_error) {
    return 'Turn done'
  }
  if (message.subtype === 'success') {
    return 'Turn failed'
  }
  return `Turn failed: ${FAILURE.get(message.subtype) ?? message.subtype.replaceAll('_', ' ')}`
}

export const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`
