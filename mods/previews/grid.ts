/** Cells read from one workbook across its sheets; rows past it are dropped. */
export const BOOK_CELL_MAX = 1_000_000

/** A block of merged cells, by its top-left cell and its size. */
export interface Merge {
  row: number
  col: number
  rows: number
  cols: number
}

/** Rows of cell text for the table view, with what a workbook adds on top. */
export interface Grid {
  rows: string[][]
  columns: number
  /** Formulas keyed by `row:col`, shown on hover over their computed values. */
  formulas: ReadonlyMap<string, string>
  merges: readonly Merge[]
  truncated: boolean
}

export interface ParsedSheet extends Grid {
  name: string
}

export const cellKey = (row: number, col: number) => `${String(row)}:${String(col)}`

/** Spreadsheet column letters: 0 is A, 25 is Z, 26 is AA. */
export function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}

/** The cell text of a table row as one tab-separated line, the way spreadsheets paste it. */
export const rowText = (row: readonly string[]) =>
  row.map((cell) => (/[\t\n"]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join('\t')
