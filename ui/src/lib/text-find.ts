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

/** What the open file does for find; the editor and the read-only view each provide it. */
export interface FindTarget {
  next: () => void
  previous: () => void
  goToLine: (line: number) => void
  /** The selected text, which find starts from when it fits on one line. */
  selection: () => string
  focus: () => void
  /** Replacing needs the editor; the read-only view leaves these out. */
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
