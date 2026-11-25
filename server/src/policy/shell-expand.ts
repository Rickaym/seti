/** Literal values of shell variables Seti knows; null for one it cannot tell. */
export type Vars = ReadonlyMap<string, string | null>

/** One piece of a word: the text it expands to (null where Seti cannot tell) and what follows. */
interface Piece {
  text: string | null
  next: number
  quoted: boolean
}

/** The value of a `$NAME` or `${NAME}` that starts `rest`, with its length; null if unknown. */
function variable(rest: string, vars: Vars): { value: string; length: number } | null {
  const named = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/.exec(rest)
  const value = named === null ? undefined : vars.get(named[1] ?? named[2] ?? '')
  return named === null || value === undefined || value === null ? null : { value, length: named[0].length }
}

/** Whether an unquoted part of a word globs or expands braces into other words. */
function globs(rest: string): boolean {
  if (/^[*?[]/.test(rest)) {
    return true
  }
  const end = rest.indexOf('}')
  const braced = rest.startsWith('{') && end > 0 ? rest.slice(1, end) : ''
  return braced.includes(',') || braced.includes('..')
}

/** The piece of a word at `at`: a quote, single-quoted text, a variable, an escape or a character. */
function piece(raw: string, at: number, quoted: boolean, vars: Vars): Piece {
  const rest = raw.slice(at)
  const char = rest[0] ?? ''
  const unknown = { text: null, next: raw.length, quoted }
  if (char === '"') {
    return { text: '', next: at + 1, quoted: !quoted }
  }
  if (char === "'" && !quoted) {
    const end = raw.indexOf("'", at + 1)
    return end < 0 ? unknown : { text: raw.slice(at + 1, end), next: end + 1, quoted }
  }
  if (char === '$') {
    const found = variable(rest, vars)
    return found === null ? unknown : { text: found.value, next: at + found.length, quoted }
  }
  if (char === '`' || (!quoted && globs(rest))) {
    return unknown
  }
  const escaped = char === '\\' && (!quoted || /^\\[$`"\\]/.test(rest))
  return escaped ? { text: rest[1] ?? '', next: at + 2, quoted } : { text: char, next: at + 1, quoted }
}

/**
 * The rest of a word from `at` as the shell expands it, or null where Seti cannot tell. `partly`
 * keeps what it cannot tell as written instead, so a `$`, a backtick or a glob still shows.
 */
function expandFrom(raw: string, from: number, vars: Vars, partly: boolean): string | null {
  let out = ''
  let quoted = false
  for (let at = from; at < raw.length;) {
    const found = piece(raw, at, quoted, vars)
    if (found.text === null && !partly) {
      return null
    }
    out += found.text ?? raw[at] ?? ''
    at = found.text === null ? at + 1 : found.next
    quoted = found.quoted
  }
  return quoted && !partly ? null : out
}

/** A word as the shell expands it, or null where it computes, globs or reads an unknown name. */
export function expand(raw: string, vars: Vars): string | null {
  if (!raw.startsWith('~')) {
    return expandFrom(raw, 0, vars, false)
  }
  const home = raw === '~' || raw.startsWith('~/') ? (vars.get('HOME') ?? null) : null
  const rest = expandFrom(raw, 1, vars, false)
  return home === null || rest === null ? null : home + rest
}

/** A word as the shell expands it, with what Seti cannot tell kept as written. */
export function expandPartly(raw: string, vars: Vars): string {
  const home = raw === '~' || raw.startsWith('~/') ? (vars.get('HOME') ?? '~') : null
  return home === null ? (expandFrom(raw, 0, vars, true) ?? raw) : home + (expandFrom(raw, 1, vars, true) ?? '')
}
