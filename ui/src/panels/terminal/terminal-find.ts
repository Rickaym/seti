import type { Terminal } from '@xterm/xterm'
import { APPLE } from './terminal-clipboard'

type FindKeys = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

/** True for the key that opens find in a terminal: Ctrl+Shift+F, or Cmd+F on a Mac. */
export function isFindChord(event: FindKeys, apple: boolean): boolean {
  if (event.key.toLowerCase() !== 'f' || event.altKey) {
    return false
  }
  if (apple && event.metaKey && !event.ctrlKey) {
    return true
  }
  return event.ctrlKey && event.shiftKey && !event.metaKey
}

/** What the count says: the match shown and how many there are, or none. */
export function matchLabel(index: number, count: number): string {
  if (count === 0) {
    return 'No matches'
  }
  return index < 0 ? `${String(count)} matches` : `${String(index + 1)} of ${String(count)}`
}

/** Raised on xterm's element when its find chord is pressed, for the view around it to open find. */
export const FIND_EVENT = 'seti-terminal-find'

/** Takes the find chord from xterm and asks for find; false for a key xterm must not handle. */
export function findKeys(term: Terminal, event: KeyboardEvent): boolean {
  if (!isFindChord(event, APPLE)) {
    return true
  }
  if (event.type === 'keydown') {
    event.preventDefault()
    term.element?.dispatchEvent(new CustomEvent(FIND_EVENT, { bubbles: true }))
  }
  return false
}
