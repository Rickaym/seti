import type { Terminal } from '@xterm/xterm'
import { toast } from 'sonner'

type ChordKeys = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

/** Apple devices, where Cmd takes the chords Ctrl takes elsewhere. */
export const APPLE = /Mac|iPhone|iPad/u.test(navigator.userAgent)

/**
 * The clipboard chord a key press is, as in VS Code: Ctrl+C copies only with a selection, so
 * without one the shell gets ^C; Ctrl+Shift+C and +V always do. On a Mac it is Cmd, and Ctrl
 * stays the shell's.
 */
export function clipboardChord(event: ChordKeys, selected: boolean, apple = APPLE): 'copy' | 'paste' | null {
  const key = event.key.toLowerCase()
  if (event.altKey || (key !== 'c' && key !== 'v')) {
    return null
  }
  const held = [event.ctrlKey, event.shiftKey, event.metaKey].map(Number).join('')
  const shifted = !apple && held === '110'
  if (held !== (apple ? '001' : '100') && !shifted) {
    return null
  }
  if (key === 'v') {
    return 'paste'
  }
  return shifted || selected ? 'copy' : null
}

/** Copies the terminal's selection to the clipboard and clears it. */
export async function copySelection(term: Terminal): Promise<void> {
  const text = term.getSelection()
  term.clearSelection()
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    toast.error('The browser did not let Seti copy to the clipboard', { duration: Infinity })
  }
}

/** Pastes the clipboard into the shell, bracketed when the shell asked for that. */
export async function pasteClipboard(term: Terminal): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text !== '') {
      term.paste(text)
    }
  } catch {
    toast.error('The browser did not let Seti read the clipboard', { duration: Infinity })
  }
}

/**
 * Takes the clipboard chords from xterm, which would send Ctrl+C and Ctrl+V to the shell and
 * cancel the browser's paste. A paste chord is left to the browser, whose paste event xterm
 * turns into a bracketed paste; it returns false for any key xterm must not handle.
 */
export function clipboardKeys(term: Terminal, event: KeyboardEvent): boolean {
  const chord = clipboardChord(event, term.hasSelection())
  if (chord === null) {
    return true
  }
  if (chord === 'copy' && event.type === 'keydown') {
    event.preventDefault()
    if (term.hasSelection()) {
      void copySelection(term)
    }
  }
  return false
}
