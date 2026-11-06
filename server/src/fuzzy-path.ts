/** How well a query matched a path: higher is better; `marks` are the matched character indexes. */
export interface PathMatch {
  score: number
  marks: number[]
}

const SEPARATORS = new Set(['/', '_', '-', '.', ' '])

/** A character that starts a word: after a separator, or an upper case letter after a lower one. */
function startsWord(text: string, at: number): boolean {
  const before = text[at - 1]
  const here = text[at] ?? ''
  if (before === undefined || SEPARATORS.has(before)) {
    return true
  }
  return before === before.toLowerCase() && here !== here.toLowerCase()
}

const range = (start: number, length: number) => Array.from({ length }, (_, i) => start + i)

/** Query characters found in order from `from`, each at its first place after the one before. */
function forward(lower: string, query: string, from: number): number[] | null {
  const marks: number[] = []
  let at = from
  for (const char of query) {
    const found = lower.indexOf(char, at)
    if (found < 0) {
      return null
    }
    marks.push(found)
    at = found + 1
  }
  return marks
}

/** Pulls each mark as late as it goes before the next one, which keeps the matched run tight. */
function tighten(lower: string, query: string, marks: number[]): number[] {
  const tight = [...marks]
  for (let i = query.length - 2; i >= 0; i--) {
    const next = tight[i + 1] ?? lower.length
    const later = lower.lastIndexOf(query[i] ?? '', next - 1)
    tight[i] = Math.max(tight[i] ?? 0, later)
  }
  return tight
}

function scatteredScore(path: string, marks: number[], nameStart: number): number {
  let score = 0
  marks.forEach((mark, i) => {
    const previous = marks[i - 1]
    if (previous !== undefined && mark === previous + 1) {
      score += 6
    } else if (previous !== undefined) {
      score -= Math.min(mark - previous, 10)
    }
    if (startsWord(path, mark)) {
      score += 8
    }
    if (mark >= nameStart) {
      score += 4
    }
  })
  return score
}

/**
 * Matches a lower case query with no spaces against a path, as editors' quick open does:
 * the query in the file name beats it anywhere in the path, which beats scattered letters.
 */
export function matchPath(path: string, query: string): PathMatch | null {
  if (query === '') {
    return null
  }
  const lower = path.toLowerCase()
  const nameStart = path.lastIndexOf('/') + 1
  const shorter = -path.length / 4
  const inName = lower.indexOf(query, nameStart)
  if (inName >= 0) {
    const whole = inName === nameStart && lower.length - nameStart === query.length ? 300 : 0
    const start = startsWord(path, inName) ? 200 : 0
    return { score: 2000 + whole + start + shorter, marks: range(inName, query.length) }
  }
  const inPath = lower.indexOf(query)
  if (inPath >= 0) {
    return { score: 1000 + (startsWord(path, inPath) ? 100 : 0) + shorter, marks: range(inPath, query.length) }
  }
  const nameOnly = forward(lower, query, nameStart)
  const marks = nameOnly ?? forward(lower, query, 0)
  if (marks === null) {
    return null
  }
  const tight = tighten(lower, query, marks)
  return { score: (nameOnly === null ? 0 : 300) + scatteredScore(path, tight, nameStart) + shorter, marks: tight }
}
