import { sandboxViolations } from '@seti/shared'

/** Characters of one tool text the browser gets before it asks for the full message. */
export const WIRE_TEXT_LIMIT = 16 * 1024

/** A value cut for the wire, with the ids of what lost text. */
export interface Wire<T> {
  value: T
  cut: string[]
}

export function formatSize(chars: number): string {
  return chars >= 1024 * 1024 ? `${(chars / 1024 / 1024).toFixed(1)} MB` : `${String(Math.ceil(chars / 1024))} KB`
}

export const marker = (original: number) =>
  `[trimmed for display: first ${formatSize(WIRE_TEXT_LIMIT)} of ${formatSize(original)} shown]`

/** What the sandbox refused, kept when the cut drops it, so trimmed output still shows it. */
function keptViolations(text: string, head: string): string {
  const violations = sandboxViolations(text)
  if (violations.length === 0 || sandboxViolations(head).length > 0) {
    return ''
  }
  return `\n<sandbox_violations>\n${violations.join('\n')}\n</sandbox_violations>`
}

/** Cuts text longer than the wire limit and marks how much the browser gets. */
export function trimText(text: string): string {
  if (text.length <= WIRE_TEXT_LIMIT) {
    return text
  }
  const head = text.slice(0, WIRE_TEXT_LIMIT)
  return `${head}\n\n${marker(text.length)}${keptViolations(text, head)}`
}

/** Trims every long string inside a JSON value, returning the same reference when nothing is cut. */
export function trimStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return trimText(value)
  }
  if (Array.isArray(value)) {
    const next = value.map(trimStrings)
    return next.some((item, index) => item !== value[index]) ? next : value
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    const next = entries.map(([key, item]) => [key, trimStrings(item)] as const)
    return next.some(([, item], index) => item !== entries[index]?.[1]) ? Object.fromEntries(next) : value
  }
  return value
}
