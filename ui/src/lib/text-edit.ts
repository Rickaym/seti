import { nextWordEnd, previousWordStart } from '@seti/shared'
import type { KeyboardEvent } from 'react'

/** Deletes the selection, or the word before or after the caret, keeping native undo when it can. */
function deleteWord(el: HTMLTextAreaElement, direction: 'back' | 'forward'): void {
  const { value, selectionStart, selectionEnd } = el
  let start = selectionStart
  let end = selectionEnd
  if (start === end) {
    if (direction === 'back') {
      start = previousWordStart(value, start)
    } else {
      end = nextWordEnd(value, end)
    }
  }
  if (start === end) {
    return
  }
  el.setSelectionRange(start, end)
  // eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation -- keeps native undo
  if (!document.execCommand('delete')) {
    el.setRangeText('', start, end, 'end')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

/** Puts text over the selection as typing would, so the caret lands after it and undo keeps it. */
export function insertText(el: HTMLTextAreaElement, text: string): void {
  el.focus()
  // eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation -- keeps native undo
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

/** Alt+Backspace and Alt+Delete delete a word like Ctrl does; returns whether it handled the key. */
export function handleWordDelete(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'Backspace' && e.key !== 'Delete')) {
    return false
  }
  e.preventDefault()
  deleteWord(e.currentTarget, e.key === 'Backspace' ? 'back' : 'forward')
  return true
}

/**
 * Puts `insert` over `from` to `to` as typing would, so undo takes it back, then gives focus back
 * to where it was, such as a find bar's field.
 */
export function replaceRange(el: HTMLTextAreaElement, from: number, to: number, insert: string): void {
  const before = document.activeElement
  el.focus({ preventScroll: true })
  el.setSelectionRange(from, to)
  insertText(el, insert)
  if (before instanceof HTMLElement && before !== el) {
    before.focus({ preventScroll: true })
  }
}
