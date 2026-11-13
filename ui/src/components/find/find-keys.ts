import { FIND_SHORTCUT, isFindShortcut } from '@/components/shortcuts/find'

const APPLE = /Mac|iPhone|iPad/u.test(navigator.userAgent)

/** What a key does in a text: open find, replace or go to line, or step through matches. */
export type TextFindKey = 'find' | 'replace' | 'line' | 'next' | 'previous'

/** How the find and edit keys read on this device. */
export const TEXT_KEYS = {
  find: FIND_SHORTCUT,
  replace: APPLE ? 'Cmd+Opt+F' : 'Ctrl+H',
  line: 'Ctrl+G',
  next: 'F3',
  previous: 'Shift+F3',
  selectNext: APPLE ? 'Cmd+D' : 'Ctrl+D',
  save: APPLE ? 'Cmd+S' : 'Ctrl+S',
  undo: APPLE ? 'Cmd+Z' : 'Ctrl+Z',
  redo: APPLE ? 'Cmd+Shift+Z' : 'Ctrl+Y',
} as const

type Stroke = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

const only = (e: Stroke, ctrl: boolean, meta: boolean, alt: boolean) =>
  e.ctrlKey === ctrl && e.metaKey === meta && e.altKey === alt

/** Cmd+Opt+F on Apple, where Cmd+H hides the browser; Ctrl+H elsewhere. */
const isReplace = (e: Stroke, apple: boolean) =>
  apple
    ? only(e, false, true, true) && !e.shiftKey && e.code === 'KeyF'
    : only(e, true, false, false) && !e.shiftKey && e.key.toLowerCase() === 'h'

/** F3 steps, Shift+F3 steps back; Apple also takes Cmd+G and Cmd+Shift+G. */
function stepOf(e: Stroke, apple: boolean): TextFindKey | null {
  const f3 = e.key === 'F3' && only(e, false, false, false)
  const cmdG = apple && e.key.toLowerCase() === 'g' && only(e, false, true, false)
  if (!f3 && !cmdG) {
    return null
  }
  return e.shiftKey ? 'previous' : 'next'
}

/** The find action a key stroke asks for in a text, or null for any other key. */
export function textFindKey(e: Stroke, apple = APPLE): TextFindKey | null {
  if (isFindShortcut(e, apple)) {
    return 'find'
  }
  if (isReplace(e, apple)) {
    return 'replace'
  }
  if (e.key.toLowerCase() === 'g' && only(e, true, false, false) && !e.shiftKey) {
    return 'line'
  }
  return stepOf(e, apple)
}
