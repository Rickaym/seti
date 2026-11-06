/** Ctrl+` does what the terminal button does, as in VS Code; xterm never gets it. */
export const TERMINAL_SHORTCUT = 'Ctrl+`'

export const TERMINAL_SHORTCUT_ARIA = 'Control+`'

export const isTerminalShortcut = (
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
): boolean => e.code === 'Backquote' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey

/** Keys typed in the terminal stay there, so app keys such as Esc do not act; Ctrl+` toggles. */
export const keepKeys = (event: KeyboardEvent) => {
  if (!isTerminalShortcut(event)) {
    event.stopPropagation()
  }
}
