import { escapeHtml } from '../share-markdown.js'
import { count, plural, type RenderedPreview } from './preview.js'

const ROWS_MAX = 1000
const COLUMNS_MAX = 50
/** A cell keeps this many characters; the rest of it is in the download. */
const CELL_CHARS_MAX = 500

/** The delimiter a TSV name says, else the likeliest of comma, semicolon and tab on line one. */
function delimiterOf(name: string, text: string): string {
  if (/\.tsv$/i.test(name)) {
    return '\t'
  }
  const end = text.indexOf('\n')
  const first = text.slice(0, end === -1 ? 4096 : end)
  let best = ','
  for (const mark of [';', '\t']) {
    if (first.split(mark).length > first.split(best).length) {
      best = mark
    }
  }
  return best
}

interface Parsed {
  /** The rows kept to show, header first, each cut to the column cap. */
  rows: string[][]
  /** Every record in the file, header included. */
  records: number
  /** The widest record's field count. */
  columns: number
}

function reader(keep: number) {
  const rows: string[][] = []
  let records = 0
  let columns = 0
  let width = 0
  let row: string[] = []
  let field = ''
  const endField = () => {
    if (row.length < COLUMNS_MAX) {
      row.push(field.length > CELL_CHARS_MAX ? `${field.slice(0, CELL_CHARS_MAX)}\u2026` : field)
    }
    width += 1
    field = ''
  }
  return {
    endField,
    add: (text: string) => {
      if (field.length <= CELL_CHARS_MAX) {
        field += text
      }
    },
    endRow: () => {
      endField()
      columns = Math.max(columns, width)
      records += 1
      if (rows.length < keep) {
        rows.push(row)
      }
      row = []
      width = 0
    },
    done: (): Parsed => ({ rows, records, columns }),
  }
}

type Reader = ReturnType<typeof reader>

/** Reads a quoted field from just past its opening quote; returns where it ends. */
function quotedField(text: string, from: number, read: Reader): number {
  let at = from
  for (;;) {
    const close = text.indexOf('"', at)
    if (close === -1) {
      read.add(text.slice(at))
      return text.length
    }
    read.add(text.slice(at, close))
    if (text[close + 1] !== '"') {
      return close + 1
    }
    read.add('"')
    at = close + 2
  }
}

/** RFC 4180 records: quoted fields may hold the delimiter, quotes and line breaks. */
export function parseTable(text: string, delimiter: string, keep = ROWS_MAX + 1): Parsed {
  const read = reader(keep)
  let at = 0
  while (at < text.length) {
    const char = text[at] ?? ''
    if (char === '"') {
      at = quotedField(text, at + 1, read)
      continue
    }
    if (char === delimiter) {
      read.endField()
    } else if (char === '\n' || char === '\r') {
      read.endRow()
      at += char === '\r' && text[at + 1] === '\n' ? 1 : 0
    } else {
      read.add(char)
    }
    at += 1
  }
  if (text !== '' && !/[\r\n]$/.test(text)) {
    read.endRow()
  }
  return read.done()
}

const cells = (row: readonly string[], width: number, tag: 'th' | 'td') =>
  Array.from({ length: width }, (_, n) => `<${tag}>${escapeHtml(row[n] ?? '')}</${tag}>`).join('')

/** A table of the first 1,000 rows and 50 columns, its header row stuck to the top. */
export function tablePreview(name: string, content: Buffer): RenderedPreview {
  const text = content.toString('utf8').replace(/^\uFEFF/, '')
  const parsed = parseTable(text, delimiterOf(name, text))
  const [header = [], ...body] = parsed.rows
  const width = Math.min(parsed.columns, COLUMNS_MAX)
  const rows = Math.max(parsed.records - 1, 0)
  const shownRows = Math.min(rows, ROWS_MAX)
  const notes = [
    rows > shownRows ? `first ${count(shownRows)} rows shown` : null,
    parsed.columns > COLUMNS_MAX ? `first ${String(COLUMNS_MAX)} columns shown` : null,
  ].filter((note) => note !== null)
  const label = `Table, ${plural(rows, 'row')}, ${plural(parsed.columns, 'column')}`
  const table = [
    '<div class="table"><table><thead><tr>',
    cells(header, width, 'th'),
    '</tr></thead><tbody>',
    body.map((row) => `<tr>${cells(row, width, 'td')}</tr>`).join(''),
    '</tbody></table></div>',
  ].join('')
  const caption = `<p class="caption">${escapeHtml([label, ...notes].join(', '))}</p>`
  return { body: caption + table, label, note: notes.length === 0 ? null : notes.join(', '), error: null, thumb: null }
}
