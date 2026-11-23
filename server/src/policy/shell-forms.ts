/** A file a command writes or reads through a redirection. */
interface Redirect {
  dir: 'out' | 'in'
  target: string
}

/** One command as allow rules see it. */
export interface CommandShape {
  /** The texts an allow rule may match: as written, and past safe variables and wrappers. */
  forms: string[]
  /** Its words, quotes removed, past safe variables and wrappers. */
  words: string[]
  redirects: Redirect[]
  /** Runs another program or acts on files through a flag, so only an exact rule approves it. */
  exactOnly: boolean
}

/** The quote a character opens or closes, or the one still open. */
function nextQuote(quote: string | null, char: string): string | null {
  if (quote === null) {
    return char === '"' || char === "'" ? char : null
  }
  return quote === char ? null : quote
}

/** Splits a command into words as written, quotes kept, at unquoted whitespace. */
export function rawWords(text: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if (char === '\\' && quote !== "'") {
      word += char + (text[i + 1] ?? '')
      i += 1
    } else if (quote === null && /\s/.test(char)) {
      words.push(word)
      word = ''
    } else {
      quote = nextQuote(quote, char)
      word += char
    }
  }
  words.push(word)
  return words.filter((w) => w !== '')
}

const unquote = (word: string) => word.replace(/\\(.)/g, '$1').replace(/["']/g, '')

const REDIRECT = /^\d*(&>>|&>|>>|>\||>&|<<<|<&|<>|>|<)(.*)$/s
const NO_FILE = /^(\/dev\/(null|stdout|stderr|fd\/\d+)|\d+|-)$/

function redirectOf(op: string, target: string): Redirect | null {
  const file = unquote(target)
  if (op === '<<<' || NO_FILE.test(file) || ((op === '>&' || op === '<&') && /^\d*-?$/.test(file))) {
    return null
  }
  return { dir: op === '<' || op === '<>' || op === '<&' ? 'in' : 'out', target: file }
}

/** The words of a command without its redirections, and the files those name. */
function withoutRedirects(words: readonly string[]): { words: string[]; redirects: Redirect[] } {
  const kept: string[] = []
  const redirects: Redirect[] = []
  for (let i = 0; i < words.length; i += 1) {
    const match = REDIRECT.exec(words[i] ?? '')
    if (match === null) {
      kept.push(words[i] ?? '')
      continue
    }
    const target = match[2] === '' ? (words[i + 1] ?? '') : (match[2] ?? '')
    i += match[2] === '' ? 1 : 0
    const redirect = redirectOf(match[1] ?? '', target)
    if (redirect !== null) {
      redirects.push(redirect)
    }
  }
  return { words: kept, redirects }
}

const ASSIGNMENT = /^([A-Za-z_]\w*)=/
const SAFE_VARIABLES = /^(LANG|LANGUAGE|LC_[A-Z]+|NO_COLOR|FORCE_COLOR|TERM|TZ|NODE_ENV|CI)$/

const isSafeAssignment = (word: string) => {
  const name = ASSIGNMENT.exec(word)?.[1]
  return name !== undefined && SAFE_VARIABLES.test(name) && !/[$`]/.test(word)
}

const DURATION = /^\d+(\.\d+)?[smhd]?$/

/** How many words to skip from `from` while each is an option, the ones in `paired` with a value. */
function options(words: readonly string[], from: number, paired: readonly string[]): number {
  let at = from
  while ((words[at] ?? '').startsWith('-')) {
    at += paired.includes(words[at] ?? '') ? 2 : 1
  }
  return at
}

type WrapperSpan = (words: readonly string[], at: number) => number | null

/** Wrappers Claude Code strips before matching: how many words each takes, or null when not one. */
const WRAPPERS: Record<string, WrapperSpan> = {
  timeout: (words, at) => {
    const end = options(words, at + 1, ['-s', '-k', '--signal', '--kill-after'])
    return DURATION.test(words[end] ?? '') ? end + 1 - at : null
  },
  time: (words, at) => options(words, at + 1, []) - at,
  nice: (words, at) => options(words, at + 1, ['-n']) - at,
  nohup: () => 1,
  noglob: () => 1,
  builtin: () => 1,
  stdbuf: (words, at) => options(words, at + 1, ['-i', '-o', '-e']) - at,
  command: (words, at) => (['-v', '-V'].includes(words[at + 1] ?? '') ? null : options(words, at + 1, []) - at),
  xargs: (words, at) => ((words[at + 1] ?? '-').startsWith('-') ? null : 1),
}

/** Programs that run another program they are handed, which a wildcard rule never approves. */
const EXEC_WRAPPERS = new Set([
  'watch',
  'setsid',
  'ionice',
  'flock',
  'env',
  'sudo',
  'doas',
  'exec',
  'nsenter',
  'chroot',
  'unshare',
  'taskset',
  'chrt',
  'parallel',
  'script',
  'unbuffer',
  'systemd-run',
  'runuser',
  'su',
  'strace',
  'ltrace',
  'xargs',
])

const FIND_ACTIONS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-rm',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
  '-files0-from',
])

/** Strips leading assignments that pass `keep` and the wrappers after them. */
function strip(raw: readonly string[], assignment: (word: string) => boolean): string[][] {
  const steps: string[][] = [[...raw]]
  let words = [...raw]
  for (;;) {
    const name = unquote(words[0] ?? '')
    const span = assignment(words[0] ?? '') ? 1 : (WRAPPERS[name]?.(words.map(unquote), 0) ?? null)
    if (span === null || span <= 0 || span >= words.length) {
      return steps
    }
    words = words.slice(span)
    steps.push(words)
  }
}

/** One command as allow rules see it, from its text as written. */
export function commandShape(text: string): CommandShape {
  const { words: raw, redirects } = withoutRedirects(rawWords(text))
  const steps = strip(raw, isSafeAssignment)
  const last = steps[steps.length - 1] ?? []
  const words = last.map(unquote)
  const [program = '', ...args] = words
  const exactOnly = EXEC_WRAPPERS.has(program) || (program === 'find' && args.some((arg) => FIND_ACTIONS.has(arg)))
  const forms = [...new Set([raw.join(' '), last.join(' ')])]
  return { forms, words, redirects, exactOnly }
}

/** Texts a deny or ask rule may match: past any assignment, each wrapper, what exec wrappers run. */
export function denyForms(text: string): string[] {
  const { words: raw } = withoutRedirects(rawWords(text))
  const steps = strip(raw, (word) => ASSIGNMENT.test(word))
  const last = steps[steps.length - 1] ?? []
  const handed = EXEC_WRAPPERS.has(unquote(last[0] ?? ''))
    ? last.flatMap((word, i) => (i > 0 && !word.startsWith('-') ? [last.slice(i)] : []))
    : []
  return [...new Set([...steps, ...handed].map((words) => words.join(' ')).filter((form) => form !== ''))]
}
