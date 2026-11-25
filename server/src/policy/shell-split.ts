import { rawWords } from './shell-forms.js'

/** A shell line cut into the commands rules match. */
export interface ShellSplit {
  /** The line's own commands, split at `&& || ; | |& &` and newlines, as written. */
  top: string[]
  /** Every command the line runs: its own, and those in substitutions, subshells, loops, scripts. */
  all: string[]
  /** Whether allow rules may approve it: fully read, with no nesting, heredoc or loose operator. */
  plain: boolean
}

/** Claude Code prompts for longer commands whatever the rules say. */
const MAX_CHARS = 10_000
const NESTING = 3

interface Scan {
  parts: string[]
  /** The operator that ends each part, '' for the last. */
  ops: string[]
  inner: string[]
  /** The index of the part each inner script sits in. */
  innerAt: number[]
  complete: boolean
  nested: boolean
}

const OPERATORS = ['&&', '||', '|&', ';;', '|', ';', '\n']

/** Reads one shell line, tracking quotes and brackets, without running anything. */
class Scanner {
  readonly scan: Scan = { parts: [], ops: [], inner: [], innerAt: [], complete: true, nested: false }
  private quote: string | null = null
  /** Open brackets: where each opened, and the quote it opened inside, which its close restores. */
  private readonly opens: { at: number; quote: string | null }[] = []
  private tick = -1
  private tickQuote: string | null = null
  private start = 0
  private dangling = false
  private readonly line: string

  constructor(line: string) {
    this.line = line
  }

  run(): Scan {
    let i = 0
    while (i < this.line.length) {
      i = this.step(i)
    }
    this.cut(this.line.length, '')
    if (this.quote !== null || this.opens.length > 0 || this.tick !== -1 || this.dangling) {
      this.scan.complete = false
    }
    return this.scan
  }

  private cut(at: number, op: string): void {
    const part = this.line.slice(this.start, at).trim()
    if (part !== '') {
      this.scan.parts.push(part)
      this.scan.ops.push(op)
      this.dangling = false
    }
  }

  private enclose(text: string): void {
    this.scan.inner.push(text)
    this.scan.innerAt.push(this.scan.parts.length)
  }

  private step(i: number): number {
    const char = this.line[i] ?? ''
    if (char === '\\' && this.quote !== "'") {
      return i + 2
    }
    if (this.quote === "'") {
      this.quote = char === "'" ? null : this.quote
      return i + 1
    }
    if (this.quote === '"') {
      return this.inDoubleQuotes(char, i)
    }
    if (char === "'" || char === '"') {
      this.quote = char
      return i + 1
    }
    return this.bracket(char, i) ?? this.operator(i) ?? i + 1
  }

  /** Inside double quotes only a substitution opens; it reads as a line of its own. */
  private inDoubleQuotes(char: string, i: number): number {
    if (char === '"') {
      this.quote = null
      return i + 1
    }
    if (char === '`' || (char === '$' && this.line[i + 1] === '(')) {
      const at = char === '`' ? i : i + 1
      this.bracket(this.line[at] ?? '', at)
      return at + 1
    }
    return i + 1
  }

  private bracket(char: string, i: number): number | null {
    if (char === '`') {
      this.backtick(i)
      return i + 1
    }
    if (char === '(') {
      this.scan.nested = true
      this.opens.push({ at: i, quote: this.quote })
      this.quote = null
      return i + 1
    }
    if (char === ')') {
      const open = this.opens.pop()
      if (open === undefined) {
        this.scan.complete = false
      } else {
        this.enclose(this.line.slice(open.at + 1, i))
        this.quote = open.quote
      }
      return i + 1
    }
    return null
  }

  private backtick(i: number): void {
    this.scan.nested = true
    if (this.tick === -1) {
      this.tick = i
      this.tickQuote = this.quote
      this.quote = null
    } else {
      this.enclose(this.line.slice(this.tick + 1, i))
      this.tick = -1
      this.quote = this.tickQuote
    }
  }

  private operator(i: number): number | null {
    if (this.line.startsWith('<<', i) && !this.line.startsWith('<<<', i)) {
      this.scan.complete = false
      return i + 2
    }
    if (this.opens.length > 0 || this.tick !== -1) {
      return null
    }
    const op = OPERATORS.find((candidate) => this.line.startsWith(candidate, i)) ?? this.background(i)
    if (op === undefined) {
      return null
    }
    this.cut(i, op)
    this.start = i + op.length
    this.dangling = ['&&', '||', '|', '|&'].includes(op)
    return i + op.length
  }

  /** A lone `&` ends a command; `&>`, `>&` and `<&` are redirections. */
  private background(i: number): string | undefined {
    const before = this.line[i - 1] ?? ''
    const after = this.line[i + 1] ?? ''
    return this.line[i] === '&' && after !== '>' && before !== '>' && before !== '<' ? '&' : undefined
  }
}

const KEYWORDS = /^(?:(?:if|then|else|elif|do|while|until|!|\{|\}|done|fi|esac)\s+)+/
const CONTROL = /^(if|for|while|until|case|select|function|\{|\[\[)\s/

/** A command without the loop, branch and group words in front of it. */
function bare(part: string): string {
  const text = part.replace(KEYWORDS, '').trimEnd()
  return (text.endsWith('}') ? text.slice(0, -1) : text).trim()
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** A word without the quotes around it. */
const unwrap = (word: string) => (/^(['"]).*\1$/s.test(word) ? word.slice(1, -1) : word)

/** The script a `sh -c` at `at` runs, or null when it runs a file or reads standard input. */
function shellScript(words: readonly string[], at: number): string | null {
  let next = at + 1
  let script = false
  while ((words[next] ?? '').startsWith('-')) {
    script ||= /^-[A-Za-z]*c/.test(words[next] ?? '')
    next += 1
  }
  return script ? (words[next] ?? null) : null
}

/** Scripts a command hands to a shell with `-c` or to `eval`, which run as commands of their own. */
function scripts(part: string): string[] {
  const words = rawWords(part)
  const found = words.flatMap((word, at) => {
    if (word === 'eval') {
      return [words.slice(at + 1).join(' ')]
    }
    const script = SHELLS.has(word) ? shellScript(words, at) : null
    return script === null ? [] : [script]
  })
  return found.map(unwrap).filter((script) => script.trim() !== '')
}

function everything(line: string, depth: number): string[] {
  const scan = new Scanner(line).run()
  const own = scan.parts.map(bare).filter((part) => part !== '')
  if (depth >= NESTING) {
    return own
  }
  const deeper = [...scan.inner, ...own.flatMap(scripts)].flatMap((inner) => everything(inner, depth + 1))
  return [...own, ...deeper]
}

/** One command of a line in order, with what joins it to its neighbours and what it nests. */
export interface ShellStep {
  /** The command without loop, branch and group words. */
  text: string
  /** The operators before and after it, '' at the ends of the line. */
  before: string
  after: string
  /** Whether it sits behind a loop, branch or group word, so it may run never or many times. */
  guarded: boolean
  /** Scripts it runs in a shell of their own: substitutions, subshells, `sh -c` and `eval`. */
  nested: string[]
}

/** Cuts a shell line into its own commands in order, each with the scripts nested in it. */
export function shellSteps(line: string): ShellStep[] {
  const scan = new Scanner(line).run()
  const steps = scan.parts.map((part, at) => {
    const text = bare(part)
    const inner = scan.inner.filter((_, index) => scan.innerAt[index] === at)
    const nested = [...inner, ...scripts(text)]
    return { text, before: scan.ops[at - 1] ?? '', after: scan.ops[at] ?? '', guarded: KEYWORDS.test(part), nested }
  })
  return steps.filter((step) => step.text !== '')
}

/** Cuts a shell line into its commands, as Claude Code does before it matches Bash rules. */
export function splitShell(line: string): ShellSplit {
  const scan = new Scanner(line).run()
  const top = scan.parts
  const plain =
    scan.complete &&
    !scan.nested &&
    top.length > 0 &&
    line.length <= MAX_CHARS &&
    !top.some((part) => CONTROL.test(`${part} `))
  return { top, all: [...new Set(everything(line, 0))], plain }
}
