import type { FindQuery } from '@/lib/text-find'

/** Enough to mark every match on screen; a common one-letter query stops counting here. */
export const MAX_MATCHES = 1000

/** Where one match sits in a text, as offsets from its start. */
export interface TextMatch {
  from: number
  to: number
}

export interface TextMatches {
  matches: TextMatch[]
  /** More matches lie past the counted ones. */
  capped: boolean
}

/** One edit that turns a text into another: put `insert` over `from` to `to`. */
export interface TextEdit {
  from: number
  to: number
  insert: string
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** The query taken literally, in any case unless it asks for case. */
export const queryPattern = (query: FindQuery): RegExp =>
  new RegExp(escapeRegExp(query.text), query.caseSensitive ? 'gu' : 'giu')

/** Every match of `query` in `text`, at most `limit` of them; none for an empty query. */
export function findMatches(text: string, query: FindQuery, limit = MAX_MATCHES): TextMatches {
  const found: TextMatches = { matches: [], capped: false }
  if (query.text === '') {
    return found
  }
  for (const match of text.matchAll(queryPattern(query))) {
    if (found.matches.length === limit) {
      found.capped = true
      break
    }
    found.matches.push({ from: match.index, to: match.index + match[0].length })
  }
  return found
}

/** The first match starting at or after `offset`, wrapping to the first; -1 when there is none. */
export function matchFrom(matches: readonly TextMatch[], offset: number): number {
  if (matches.length === 0) {
    return -1
  }
  return Math.max(
    0,
    matches.findIndex((match) => match.from >= offset),
  )
}

/** The match `by` steps from `index`, wrapping at both ends; -1 when there is none. */
export function stepMatch(index: number, total: number, by: 1 | -1): number {
  if (total === 0) {
    return -1
  }
  if (index < 0) {
    return by > 0 ? 0 : total - 1
  }
  return (index + by + total) % total
}

/** The edit that puts `replacement` over one match. */
export const replaceOneEdit = (match: TextMatch, replacement: string): TextEdit => ({ ...match, insert: replacement })

/**
 * The single edit that replaces every match of `query`, spanning the first to the last, so one
 * undo takes it back; null when nothing matches.
 */
export function replaceAllEdit(text: string, query: FindQuery, replacement: string): TextEdit | null {
  const { matches } = findMatches(text, query, Number.POSITIVE_INFINITY)
  const first = matches.at(0)
  const last = matches.at(-1)
  if (first === undefined || last === undefined) {
    return null
  }
  const insert = text.slice(first.from, last.to).replace(queryPattern(query), () => replacement)
  return { from: first.from, to: last.to, insert }
}
