/** What find looks for: the text, taken literally. */
export interface FindQuery {
  text: string
  caseSensitive: boolean
}

/** Where find stands: the match shown, counted from 0 or -1 for none, out of how many. */
export interface FindCount {
  index: number
  total: number
  /** More matches lie past the counted ones. */
  capped: boolean
}

/** What a text does for find: a file's editor or read-only view, or a message box. */
export interface FindTarget {
  next: () => void
  previous: () => void
  /** Files offer it; a message box leaves it out. */
  goToLine?: (line: number) => void
  /** The selected text, which find starts from when it fits on one line. */
  selection: () => string
  focus: () => void
  /** Replacing needs an editable text; the read-only view leaves these out. */
  replace?: (replacement: string) => void
  replaceAll?: (replacement: string) => void
}

/** "3 of 12", "No matches", or nothing while the field is empty. */
export function findCountLabel(text: string, count: FindCount | null): string {
  if (text === '' || count === null) {
    return ''
  }
  if (count.total === 0) {
    return 'No matches'
  }
  const total = `${String(count.total)}${count.capped ? '+' : ''}`
  return count.index < 0 ? `${total} found` : `${String(count.index + 1)} of ${total}`
}
