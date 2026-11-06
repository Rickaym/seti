import { z } from 'zod'

export const SHELL_PREFIX = '!'

/** How many of the newest `!` runs since the agent last read a message go with the next one. */
export const SHELL_CONTEXT_RUNS = 10

export const shellInput = z.object({
  command: z.string().trim().min(1, 'command is required').max(20_000),
})

/** A finished `!` command the user ran in the task directory. */
export interface ShellResult {
  run_id: string
  command: string
  cwd: string
  started_at: string
  /** Null when the command did not exit on its own or could not start. */
  exit_code: number | null
  signal: string | null
  /** Why the command was ended early, or null when it exited on its own. */
  ended_by: 'timeout' | 'user' | null
  duration_ms: number
  stdout: string
  stderr: string
}

/** The live state of a running `!` command; output holds the newest part only. */
export interface ShellProgress {
  run_id: string
  command: string
  cwd: string
  started_at: string
  stdout: string
  stderr: string
}

type QuoteState = 'none' | 'single' | 'double' | 'backtick'

const QUOTE_OF: Record<string, QuoteState> = { "'": 'single', '"': 'double', '`': 'backtick' }

const UNCLOSED: Record<Exclude<QuoteState, 'none'>, string> = {
  single: 'Unclosed single quote',
  double: 'Unclosed double quote',
  backtick: 'Unclosed backtick',
}

const startsWord = (text: string, index: number) => index === 0 || /[\s;&|(]/.test(text.charAt(index - 1))

/** Index just past the end of the comment line starting at `index`. */
const skipComment = (text: string, index: number) => {
  const end = text.indexOf('\n', index)
  return end === -1 ? text.length : end
}

interface Scan {
  state: QuoteState
  trailingBackslash: boolean
}

/** Index of the next character to scan after position `i`, given the quote state there. */
function step(text: string, i: number, state: QuoteState): number {
  const c = text.charAt(i)
  if (c === '\\' && state !== 'single') {
    return i + 2
  }
  return state === 'none' && c === '#' && startsWord(text, i) ? skipComment(text, i) : i + 1
}

function quoteState(text: string): Scan {
  let state: QuoteState = 'none'
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    if (c === '\\' && state !== 'single' && i === text.length - 1) {
      return { state, trailingBackslash: true }
    }
    const next = step(text, i, state)
    const quote = QUOTE_OF[c]
    if (next === i + 1 && quote !== undefined && (state === 'none' || state === quote)) {
      state = state === 'none' ? quote : 'none'
    }
    i = next
  }
  return { state, trailingBackslash: false }
}

const DANGLING_OPERATOR = /(?:^|[^|&])(\|\||&&|\|)\s*$/

/** Cheap checks that catch commands bash would reject; an empty list means none were found. */
export function shellIssues(command: string): string[] {
  const text = command.trim()
  if (text === '') {
    return ['Empty command']
  }
  const issues: string[] = []
  const { state, trailingBackslash } = quoteState(text)
  if (state !== 'none') {
    issues.push(UNCLOSED[state])
  }
  if (trailingBackslash) {
    issues.push('Ends with a line continuation')
  }
  if (state === 'none' && DANGLING_OPERATOR.test(text)) {
    issues.push('Ends with an operator that needs another command')
  }
  return issues
}
