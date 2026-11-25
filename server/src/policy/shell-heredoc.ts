import { denyForms, rawWords } from './shell-forms.js'

/** A heredoc a command opened: the line that ends it, and how its body reads. */
export interface Heredoc {
  delimiter: string
  /** `<<-`: leading tabs do not count against the delimiter. */
  tabs: boolean
  /** A quoted delimiter: the shell expands nothing in the body. */
  quoted: boolean
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'source', '.', 'eval'])
const DELIMITER = /^(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|<>()'"\\])+)/

const unquote = (word: string) => word.replace(/\\(.)/g, '$1').replace(/["']/g, '')

/** Whether a command of the line that opens a heredoc is a shell, past wrappers and pipes. */
export function runsInput(line: string): boolean {
  return line
    .split(/&&|\|\|?|;|&/)
    .flatMap((command) => denyForms(command))
    .some((form) => {
      const program = unquote(rawWords(form)[0] ?? '')
      return SHELLS.has(program) || SHELLS.has(program.split('/').pop() ?? '')
    })
}

/** The heredoc a `<<` at `at` opens; null when no delimiter word follows. */
export function heredocAt(line: string, at: number): Heredoc | null {
  const found = DELIMITER.exec(line.slice(at + 2))
  const word = found?.[2]
  if (found === null || word === undefined) {
    return null
  }
  return { delimiter: unquote(word), tabs: found[1] === '-', quoted: /['"\\]/.test(word) }
}

/** A heredoc's body from `from`, and where its delimiter line ends; null when no line ends it. */
export function heredocBody(line: string, from: number, doc: Heredoc): { body: string; end: number } | null {
  let at = from
  while (at <= line.length) {
    const newline = line.indexOf('\n', at)
    const end = newline < 0 ? line.length : newline
    const text = line.slice(at, end)
    if ((doc.tabs ? text.replace(/^\t+/, '') : text) === doc.delimiter) {
      return { body: line.slice(from, at), end }
    }
    if (newline < 0) {
      return null
    }
    at = newline + 1
  }
  return null
}
