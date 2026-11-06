import type { PermissionMode, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

/** Separates the facts on one transcript line. */
export const DOT = ' \u00b7 '

const ONE_MILLION = /\[1m\]$/i

/** A model id as people say it: claude-opus-5-5 reads "Opus 5.5"; an unknown shape stays as is. */
export function modelLabel(id: string): string {
  const start = id.indexOf('claude-')
  if (start === -1) {
    return id
  }
  const parts = id
    .slice(start + 'claude-'.length)
    .replace(ONE_MILLION, '')
    .split('-')
  const family = parts.find((part) => /^[a-z]+$/i.test(part))
  if (family === undefined) {
    return id
  }
  const version = parts.filter((part) => /^\d{1,2}$/.test(part)).join('.')
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()}`
  const label = version === '' ? name : `${name} ${version}`
  return ONE_MILLION.test(id) ? `${label} 1M` : label
}

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
