import path from 'node:path'

/** A redirection of a simple command, such as `2>` to `/dev/null` or `>&` to `1`. */
export interface Redirect {
  op: string
  target: string
}

/** One simple command of a shell line: its words with quotes removed, and its redirections. */
export interface ShellCommand {
  words: string[]
  redirects: Redirect[]
}

type Token = { kind: 'word'; text: string } | { kind: 'op'; text: string } | { kind: 'break' }

const REDIRECTS = ['&>>', '&>', '>>', '>|', '>&', '<<<', '<<-', '<<', '<>', '<&', '>', '<']
const BREAKS = ['&&', '||', ';;', ';', '|&', '|', '&', '\n', '(', ')', '`']
const DOUBLE_QUOTE_ESCAPES = new Set(['$', '`', '"', '\\', '\n'])

/** The text of a double-quoted string starting at `open`, and the index past its closing quote. */
function doubleQuoted(line: string, open: number): [string, number] {
  let text = ''
  let i = open + 1
  while (i < line.length && line[i] !== '"') {
    const next = line[i + 1]
    if (line[i] === '\\' && next !== undefined && DOUBLE_QUOTE_ESCAPES.has(next)) {
      text += next === '\n' ? '' : next
      i += 2
    } else {
      text += line[i] ?? ''
      i += 1
    }
  }
  return [text, i + 1]
}

/** Splits a shell line into words, redirection operators and command breaks, as a shell reads it. */
class Lexer {
  readonly tokens: Token[] = []
  private readonly line: string
  private word = ''
  private started = false
  private quoted = false

  constructor(line: string) {
    this.line = line
  }

  run(): Token[] {
    let i = 0
    while (i < this.line.length) {
      i = this.step(i)
    }
    this.end()
    return this.tokens
  }

  private add(text: string, quoted: boolean): void {
    this.word += text
    this.started = true
    this.quoted ||= quoted
  }

  private end(): void {
    if (this.started) {
      this.tokens.push({ kind: 'word', text: this.word })
    }
    this.word = ''
    this.started = false
    this.quoted = false
  }

  private step(i: number): number {
    const char = this.line[i] ?? ''
    if (char === '\\') {
      const next = this.line[i + 1] ?? ''
      this.add(next === '\n' ? '' : next, false)
      return i + 2
    }
    if (char === "'") {
      const close = this.line.indexOf("'", i + 1)
      const stop = close === -1 ? this.line.length : close
      this.add(this.line.slice(i + 1, stop), true)
      return stop + 1
    }
    if (char === '"') {
      const [text, next] = doubleQuoted(this.line, i)
      this.add(text, true)
      return next
    }
    if (char !== '\n' && /\s/.test(char)) {
      this.end()
      return i + 1
    }
    return this.operator(i) ?? this.plain(char, i)
  }

  private operator(i: number): number | null {
    const op = REDIRECTS.find((candidate) => this.line.startsWith(candidate, i))
    if (op !== undefined) {
      // A number right before a redirection is the descriptor it redirects, not a word.
      if (this.started && !this.quoted && /^\d+$/.test(this.word)) {
        this.word = ''
        this.started = false
      }
      this.end()
      this.tokens.push({ kind: 'op', text: op })
      return i + op.length
    }
    const brk = BREAKS.find((candidate) => this.line.startsWith(candidate, i))
    if (brk === undefined) {
      return null
    }
    this.end()
    this.tokens.push({ kind: 'break' })
    return i + brk.length
  }

  private plain(char: string, i: number): number {
    this.add(char, false)
    return i + 1
  }
}

/** The simple commands of a shell line, split at pipes, lists, subshells and substitutions. */
export function shellCommands(line: string): ShellCommand[] {
  const commands: ShellCommand[] = []
  let current: ShellCommand = { words: [], redirects: [] }
  const tokens = new Lexer(line).run()
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token?.kind === 'word') {
      current.words.push(token.text)
    } else if (token?.kind === 'op') {
      const next = tokens[i + 1]
      if (next?.kind === 'word') {
        current.redirects.push({ op: token.text, target: next.text })
        i += 1
      }
    } else {
      commands.push(current)
      current = { words: [], redirects: [] }
    }
  }
  commands.push(current)
  return commands.filter((command) => command.words.length > 0 || command.redirects.length > 0)
}

/** Wrappers that run the command after them; xargs hands it arguments no one can see. */
const PREFIXES = new Set(['sudo', 'command', 'exec', 'nice', 'nohup', 'time', 'env', 'xargs'])
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])

/** A simple command: its words past env assignments and wrappers, and whether xargs feeds it. */
export interface SimpleCommand {
  words: string[]
  xargs: boolean
}

export function commandWords(words: readonly string[]): SimpleCommand {
  const start = words.findIndex((word) => !/^\w+=/.test(word) && !PREFIXES.has(word) && !KEYWORDS.has(word))
  const lead = start === -1 ? words : words.slice(0, start)
  return { words: start === -1 ? [] : words.slice(start), xargs: lead.includes('xargs') }
}

export const expandHome = (target: string, home: string) => {
  const variable = /^(\$HOME|\$\{HOME\})(\/|$)/.exec(target)
  if (variable !== null) {
    return path.join(home, target.slice(variable[1]?.length ?? 0))
  }
  return target === '~' || target.startsWith('~/') ? path.join(home, target.slice(1)) : target
}

/** The directory a cd moves to, null when it cannot be told. */
export function cdTarget(words: readonly string[], cwd: string | null, home: string): string | null {
  const target = words[1] ?? '~'
  if (/[$`]/.test(target.replace(/^(\$HOME|\$\{HOME\})(?=\/|$)/, ''))) {
    return null
  }
  const expanded = expandHome(target, home)
  if (path.isAbsolute(expanded)) {
    return expanded
  }
  return cwd === null ? null : path.resolve(cwd, expanded)
}
