import { read, type CellObject, type WorkSheet } from 'xlsx'
import { BOOK_CELL_MAX, cellKey, type Merge, type ParsedSheet } from './grid'

const pad = (n: number) => String(n).padStart(2, '0')

function dateText(date: Date): string {
  const day = `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const time = date.getUTCHours() * 60 + date.getUTCMinutes()
  return time === 0 ? day : `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function cellText(cell: CellObject | undefined): string {
  if (cell === undefined || cell.t === 'z') {
    return ''
  }
  if (cell.w !== undefined) {
    return cell.w
  }
  if (cell.v instanceof Date) {
    return dateText(cell.v)
  }
  return cell.v === undefined ? '' : String(cell.v)
}

function readSheet(name: string, sheet: WorkSheet, budget: number): { sheet: ParsedSheet; cells: number } {
  const data = sheet['!data'] ?? []
  const rows: string[][] = []
  const formulas = new Map<string, string>()
  let columns = 0
  let cells = 0
  let truncated = false
  let lastFilled = -1
  for (let r = 0; r < data.length; r++) {
    const source = data[r] ?? []
    if (cells + source.length > budget) {
      truncated = true
      break
    }
    const row: string[] = []
    for (let c = 0; c < source.length; c++) {
      const cell = source[c]
      row.push(cellText(cell))
      if (cell?.f !== undefined) {
        formulas.set(cellKey(r, c), `=${cell.f}`)
      }
    }
    while (row.length > 0 && row.at(-1) === '') {
      row.pop()
    }
    if (row.length > 0) {
      lastFilled = r
    }
    cells += source.length
    columns = Math.max(columns, row.length)
    rows.push(row)
  }
  rows.length = lastFilled + 1
  const merges: Merge[] = (sheet['!merges'] ?? [])
    .filter((range) => range.s.r < rows.length)
    .map((range) => ({
      row: range.s.r,
      col: range.s.c,
      rows: range.e.r - range.s.r + 1,
      cols: range.e.c - range.s.c + 1,
    }))
  return { sheet: { name, rows, columns, formulas, merges, truncated }, cells }
}

/** Every sheet of an xlsx, xls or ods file as cell text, formatted the way the file asks. */
export function readWorkbook(data: ArrayBuffer, maxCells = BOOK_CELL_MAX): ParsedSheet[] {
  const book = read(data, { type: 'array', dense: true, cellDates: true, cellNF: true, cellFormula: true })
  let budget = maxCells
  return book.SheetNames.flatMap((name) => {
    const sheet = book.Sheets[name]
    if (sheet === undefined) {
      return []
    }
    const parsed = readSheet(name, sheet, budget)
    budget -= parsed.cells
    return [parsed.sheet]
  })
}
