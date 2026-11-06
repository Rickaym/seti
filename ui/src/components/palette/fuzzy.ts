/** How well a query matched one string, and which characters of the string it matched. */
export interface FuzzyMatch {
  score: number
  positions: number[]
}

const GAP_LEADING = -0.005
const GAP_TRAILING = -0.005
const GAP_INNER = -0.01
const MATCH_CONSECUTIVE = 1
const MATCH_SLASH = 0.9
const MATCH_WORD = 0.8
const MATCH_CAPITAL = 0.7
const MATCH_DOT = 0.6
const EXACT = 1000
const MAX_TEXT = 256

const WORD_SEPARATORS = new Set([' ', '-', '_', '#', ':', '(', '[', '"', "'"])

function bonusAt(text: string, index: number): number {
  const previous = index === 0 ? '/' : text.charAt(index - 1)
  if (previous === '/') {
    return MATCH_SLASH
  }
  if (WORD_SEPARATORS.has(previous)) {
    return MATCH_WORD
  }
  if (previous === '.') {
    return MATCH_DOT
  }
  const current = text.charAt(index)
  const startsCapital = previous.toLowerCase() === previous && current.toUpperCase() === current
  return startsCapital && current.toLowerCase() !== current ? MATCH_CAPITAL : 0
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0
  for (const char of needle) {
    at = haystack.indexOf(char, at) + 1
    if (at === 0) {
      return false
    }
  }
  return true
}

interface Rows {
  /** Best score with this query character matched exactly here. */
  ended: number[]
  /** Best score with this query character matched here or earlier. */
  best: number[]
}

/** One row of the fzy table: query character `i` against every text position. */
function scoreRow(
  { char, gap }: { char: string; gap: number },
  { haystack, bonus }: { haystack: string; bonus: readonly number[] },
  previousRows: Rows | null,
): Rows {
  const m = haystack.length
  const ended = new Array<number>(m).fill(-Infinity)
  const best = new Array<number>(m).fill(-Infinity)
  let running = -Infinity
  for (let j = 0; j < m; j += 1) {
    if (char === haystack.charAt(j)) {
      const score =
        previousRows === null
          ? j * GAP_LEADING + (bonus[j] ?? 0)
          : Math.max(
              (previousRows.best[j - 1] ?? -Infinity) + (bonus[j] ?? 0),
              (previousRows.ended[j - 1] ?? -Infinity) + MATCH_CONSECUTIVE,
            )
      ended[j] = score
      running = Math.max(score, running + gap)
    } else {
      running += gap
    }
    best[j] = running
  }
  return { ended, best }
}

/**
 * Scores `query` as an ordered subsequence of `text`, ignoring case: matches at word starts and
 * runs of consecutive characters score higher, gaps cost a little. Null when it does not match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = query.toLowerCase()
  const original = text.slice(0, MAX_TEXT)
  const haystack = original.toLowerCase()
  const n = needle.length
  const m = haystack.length
  if (n === 0 || n > m || !isSubsequence(needle, haystack)) {
    return null
  }
  if (n === m) {
    return { score: EXACT, positions: Array.from({ length: n }, (_, index) => index) }
  }
  const bonus = Array.from({ length: m }, (_, j) => bonusAt(original, j))
  const rows: Rows[] = []
  for (let i = 0; i < n; i += 1) {
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER
    rows.push(scoreRow({ char: needle.charAt(i), gap }, { haystack, bonus }, rows.at(-1) ?? null))
  }
  return { score: rows.at(-1)?.best[m - 1] ?? -Infinity, positions: backtrack(rows, n, m) }
}

/** Walks the table back from the end to find which text position each query character took. */
function backtrack(rows: readonly Rows[], n: number, m: number): number[] {
  const positions = new Array<number>(n).fill(0)
  let mustMatch = false
  let j = m - 1
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = rows[i]
    for (; row !== undefined && j >= 0; j -= 1) {
      const score = row.ended[j] ?? -Infinity
      if (score !== -Infinity && (mustMatch || score === row.best[j])) {
        const previous = rows[i - 1]?.ended[j - 1] ?? -Infinity
        mustMatch = i > 0 && j > 0 && row.best[j] === previous + MATCH_CONSECUTIVE
        positions[i] = j
        j -= 1
        break
      }
    }
  }
  return positions
}

/** Where each field of an item matched; only shown fields carry highlights. */
export interface FieldsMatch {
  score: number
  /** Matched character positions per field, in field order. */
  positions: number[][]
}

/** Field weights: the title counts most, the second line less, hidden keywords least. */
const FIELD_WEIGHTS = [1, 0.6, 0.4]
const FIELD_PENALTY = 0.5
const MAX_SPREAD = 2

/** Secondary fields are long, so a term there must match in a short stretch, not scattered. */
const tight = (term: string, match: FuzzyMatch) =>
  (match.positions.at(-1) ?? 0) - (match.positions[0] ?? 0) < term.length * MAX_SPREAD

/**
 * Every whitespace-separated term of `query` must match one field, trying them in order;
 * a term found only in a later field scores less. Null when some term matches nowhere.
 */
export function matchFields(query: string, fields: readonly string[]): FieldsMatch | null {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((term) => term !== '')
  if (terms.length === 0) {
    return null
  }
  const positions = fields.map((): number[] => [])
  let score = 0
  for (const term of terms) {
    const hit = fields
      .map((field, index) => ({ index, match: fuzzyMatch(term, field) }))
      .find(({ index, match }) => match !== null && (index === 0 || tight(term, match)))
    const match = hit?.match ?? null
    if (hit === undefined || match === null) {
      return null
    }
    const weight = FIELD_WEIGHTS[hit.index] ?? FIELD_WEIGHTS.at(-1) ?? 1
    score += match.score * weight - hit.index * FIELD_PENALTY
    positions[hit.index]?.push(...match.positions)
  }
  return { score, positions }
}
