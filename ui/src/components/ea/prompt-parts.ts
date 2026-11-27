import type { EaPromptPart } from '@seti/shared'

const COUNT = new Intl.NumberFormat('en')
const SHORT_COMMIT = 7

/** One stretch of a part's text, marked when it matches the search. */
export interface Piece {
  from: number
  text: string
  match: boolean
}

export const chars = (n: number) => `${COUNT.format(n)} ${n === 1 ? 'character' : 'characters'}`

/** The summary line: the whole size, how many parts, and the build the EA runs. */
export function sizeText(parts: readonly EaPromptPart[], commit: string | null): string {
  const total = parts.reduce((sum, part) => sum + part.chars, 0)
  const build = commit === null ? 'build unknown' : `build ${commit.slice(0, SHORT_COMMIT)}`
  const count = `${String(parts.length)} ${parts.length === 1 ? 'part' : 'parts'}`
  return `${chars(total)} in ${count}; ${build}`
}

/** The text cut at every case-insensitive match of the query, in order. */
export function pieces(text: string, query: string): Piece[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return [{ from: 0, text, match: false }]
  }
  const lower = text.toLowerCase()
  const out: Piece[] = []
  let at = 0
  for (let hit = lower.indexOf(needle); hit !== -1; hit = lower.indexOf(needle, hit + needle.length)) {
    if (hit > at) {
      out.push({ from: at, text: text.slice(at, hit), match: false })
    }
    out.push({ from: hit, text: text.slice(hit, hit + needle.length), match: true })
    at = hit + needle.length
  }
  if (at < text.length) {
    out.push({ from: at, text: text.slice(at), match: false })
  }
  return out
}

/** How many times the query occurs in a part's text. */
export const matchCount = (text: string, query: string) => pieces(text, query).filter((p) => p.match).length

/** A part is open when the user opened it, or while a search finds something in it. */
export const partOpen = (part: EaPromptPart, query: string, opened: ReadonlySet<string>) =>
  query.trim() === '' ? opened.has(part.key) : matchCount(part.text, query) > 0
