export type Delimiter = ',' | ';' | '\t'

const CANDIDATES: readonly Delimiter[] = [',', ';', '\t']

export const DELIMITER_NAMES: Record<Delimiter, string> = { ',': 'Comma', ';': 'Semicolon', '\t': 'Tab' }

const SAMPLE_ROWS = 20
const SAMPLE_CHARS = 64 * 1024

const QUOTE = 34
const CR = 13
const LF = 10

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

export interface ParsedTable {
  rows: string[][]
  /** The widest row's field count. */
  columns: number
  /** Parsing stopped at a cap; the rows kept are complete. */
  truncated: boolean
}

interface Field {
  value: string
  next: number
}

/** A field that opens with a quote: "" is one quote, and text after the closing quote is kept. */
function readQuoted(text: string, open: number, ends: (code: number) => boolean): Field {
  let value = ''
  let start = open + 1
  let i = start
  for (;;) {
    const close = text.indexOf('"', i)
    if (close === -1) {
      return { value: value + text.slice(start), next: text.length }
    }
    if (text.charCodeAt(close + 1) !== QUOTE) {
      value += text.slice(start, close)
      i = close + 1
      break
    }
    value += text.slice(start, close + 1)
    i = close + 2
    start = i
  }
  let end = i
  while (end < text.length && !ends(text.charCodeAt(end))) {
    end++
  }
  return { value: value + text.slice(i, end), next: end }
}

function readField(text: string, at: number, ends: (code: number) => boolean): Field {
  if (text.charCodeAt(at) === QUOTE) {
    return readQuoted(text, at, ends)
  }
  let end = at
  while (end < text.length && !ends(text.charCodeAt(end))) {
    end++
  }
  return { value: text.slice(at, end), next: end }
}

export interface ParseLimits {
  maxCells?: number
  maxRows?: number
}

/** RFC 4180 rows: quoted fields may hold the delimiter, "" and line breaks. */
export function parseDelimited(input: string, delimiter: Delimiter, limits: ParseLimits = {}): ParsedTable {
  const { maxCells = Infinity, maxRows = Infinity } = limits
  const text = stripBom(input)
  const sep = delimiter.charCodeAt(0)
  const ends = (code: number) => code === sep || code === CR || code === LF
  const rows: string[][] = []
  let row: string[] = []
  let cells = 0
  let columns = 0
  let i = 0
  while (i < text.length) {
    const field = readField(text, i, ends)
    row.push(field.value)
    i = field.next
    if (text.charCodeAt(i) === sep) {
      i++
      if (i < text.length) {
        continue
      }
      row.push('')
    } else {
      i += text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF ? 2 : 1
    }
    rows.push(row)
    cells += row.length
    columns = Math.max(columns, row.length)
    row = []
    if ((cells >= maxCells || rows.length >= maxRows) && i < text.length) {
      return { rows, columns, truncated: true }
    }
  }
  return { rows, columns, truncated: false }
}

/** The candidate that splits the first rows most often into the same number of fields. */
export function detectDelimiter(input: string): Delimiter {
  const sample = input.slice(0, SAMPLE_CHARS)
  let best: Delimiter = ','
  let bestScore = 0
  for (const delimiter of CANDIDATES) {
    const { rows } = parseDelimited(sample, delimiter, { maxRows: SAMPLE_ROWS })
    const width = rows[0]?.length ?? 0
    const score = width < 2 ? 0 : rows.filter((row) => row.length === width).length * 1000 + width
    if (score > bestScore) {
      best = delimiter
      bestScore = score
    }
  }
  return best
}
