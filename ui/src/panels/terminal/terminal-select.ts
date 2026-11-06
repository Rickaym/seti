/** Characters that end the word a long press selects, so a path, flag or URL selects whole. */
const BREAK = /[\s"'`()<>[\]{}|,;]/u

/** The word around column `col` of a line, or null on a gap between words. */
export function wordAt(line: string, col: number): { start: number; length: number } | null {
  const at = line[col]
  if (at === undefined || BREAK.test(at)) {
    return null
  }
  let start = col
  while (start > 0 && !BREAK.test(line[start - 1] ?? ' ')) {
    start -= 1
  }
  let end = col + 1
  while (end < line.length && !BREAK.test(line[end] ?? ' ')) {
    end += 1
  }
  return { start, length: end - start }
}

/** A cell of the terminal: its column and its row in the whole buffer. */
export interface Cell {
  col: number
  row: number
}

/** The selection from `anchor` to `focus` in either order, as xterm's select takes it. */
export function spanBetween(anchor: Cell, focus: Cell, cols: number): { col: number; row: number; length: number } {
  const forward = focus.row > anchor.row || (focus.row === anchor.row && focus.col >= anchor.col)
  const [from, to] = forward ? [anchor, focus] : [focus, anchor]
  return { col: from.col, row: from.row, length: (to.row - from.row) * cols + to.col - from.col + 1 }
}

/** The web address a selection is, or null; a trailing full stop is left out. */
export function selectedUrl(text: string): string | null {
  const trimmed = text.trim().replace(/[.,]$/u, '')
  return /^https?:\/\/\S+$/u.test(trimmed) ? trimmed : null
}
