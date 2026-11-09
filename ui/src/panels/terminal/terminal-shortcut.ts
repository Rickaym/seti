import { hookTakesTerminalKey } from '@/lib/input-hooks'

/** Ctrl+` does what the terminal button does, as in VS Code; xterm never gets it. */
export const TERMINAL_SHORTCUT = 'Ctrl+`'

export const TERMINAL_SHORTCUT_ARIA = 'Control+`'

export const isTerminalShortcut = (
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
): boolean => e.code === 'Backquote' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey

/** Keys the shell never gets: Ctrl+`, and keys an input hook such as Vim mode takes. */
export const leavesTerminal = (e: KeyboardEvent): boolean => isTerminalShortcut(e) || hookTakesTerminalKey(e)

/** Keys typed in the terminal stay there, so app keys such as Esc do not act. */
export const keepKeys = (event: KeyboardEvent) => {
  if (!leavesTerminal(event)) {
    event.stopPropagation()
  }
}
