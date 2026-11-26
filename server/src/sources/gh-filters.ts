/** jq that can print text the read did not hold: literals, variables, the environment, input. */
const JQ_ADDS =
  /["$]|\b(?:env|implode|ascii|input|inputs|input_filename|debug|stderr|def|include|import)\b|@base(?:32|64)d/

/** Whether a jq program only selects and reshapes what gh read, adding no text of its own. */
export const cleanJq = (program: string): boolean => program.length <= 2000 && !JQ_ADDS.test(program)

interface Filter {
  /** Options that take a value. */
  paired: readonly string[]
  /** Options that read a file, run a program or write elsewhere, so the output is not the input. */
  refused: readonly string[]
}

const GREP: Filter = {
  paired: ['-e', '--regexp', '-m', '--max-count', '-A', '-B', '-C', '--color', '--colour'],
  refused: ['-f', '--file', '-r', '-R', '--recursive', '--dereference-recursive', '--pre', '--replace'],
}
const LINES: Filter = { paired: ['-n', '-c', '--lines', '--bytes'], refused: [] }

const FILTERS: Readonly<Record<string, Filter>> = {
  head: LINES,
  tail: LINES,
  grep: GREP,
  rg: GREP,
  sort: { paired: ['-k', '--key', '-t', '--field-separator'], refused: ['-o', '--output', '--files0-from'] },
  uniq: { paired: ['-f', '-s', '-w'], refused: [] },
  wc: { paired: [], refused: ['--files0-from'] },
  cut: { paired: ['-d', '--delimiter', '-f', '--fields', '-c', '--characters', '-b', '--bytes'], refused: [] },
  jq: { paired: [], refused: ['-f', '--from-file', '--rawfile', '--slurpfile', '--arg', '--argjson', '--args'] },
}

const PATTERNS = new Set(['-e', '--regexp'])

/** A filter's words without options and their values; null when it uses a refused option. */
function positionals(words: readonly string[], filter: Filter): string[] | null {
  const found: string[] = []
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? ''
    const name = word.split('=', 1)[0] ?? ''
    const letters = /^-[A-Za-z0-9]{2,}$/.test(word) ? (word.match(/[A-Za-z0-9]/g) ?? []).map((l) => `-${l}`) : []
    if ([name, ...letters].some((option) => filter.refused.includes(option))) {
      return null
    }
    if (word === '--') {
      return [...found, ...words.slice(at + 1)]
    }
    if (!word.startsWith('-') || word === '-') {
      found.push(word)
    } else if (filter.paired.includes(word)) {
      at += 1
    }
  }
  return found
}

const SED_PRINT = /^\d{1,9}(?:,\d{1,9})?p$/

/** How many words a filter may take besides options: grep its pattern, jq its program. */
function allowedWords(program: string, words: readonly string[]): number {
  if (program === 'grep' || program === 'rg') {
    return words.some((word) => PATTERNS.has(word)) ? 0 : 1
  }
  return program === 'jq' ? 1 : 0
}

/**
 * Whether one command after a pipe only cuts, orders or counts its input, so what it prints is
 * part of what came in: no file it reads, no program it runs, no text it writes of its own.
 * `words` are unquoted; a word the shell computes is never clean.
 */
export function cleanFilter(words: readonly string[]): boolean {
  const [program = '', ...args] = words
  if (words.some((word) => /[$`]/.test(word))) {
    return false
  }
  if (program === 'sed') {
    return args.length === 2 && args[0] === '-n' && SED_PRINT.test(args[1] ?? '')
  }
  const filter = Object.hasOwn(FILTERS, program) ? FILTERS[program] : undefined
  const rest = filter === undefined ? null : positionals(args, filter)
  if (rest === null || rest.length > allowedWords(program, args)) {
    return false
  }
  return program !== 'jq' || cleanJq(rest[0] ?? '.')
}
