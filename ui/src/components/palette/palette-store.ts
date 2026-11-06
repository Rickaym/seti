import { useSyncExternalStore } from 'react'

/** Typed first to switch the palette from places to commands, as in VS Code. */
export const COMMAND_PREFIX = '>'

interface PaletteState {
  open: boolean
  /** What the input starts with when the palette opens. */
  initialQuery: string
}

let state: PaletteState = { open: false, initialQuery: '' }
let returnFocus: HTMLElement | null = null
const listeners = new Set<() => void>()

function set(next: PaletteState): void {
  state = next
  for (const listener of listeners) {
    listener()
  }
}

export function openPalette(initialQuery = ''): void {
  if (!state.open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  set({ open: true, initialQuery })
}

/** Where focus was when the palette opened, handed out once. */
export function takeReturnFocus(): HTMLElement | null {
  const element = returnFocus
  returnFocus = null
  return element
}

export function closePalette(): void {
  if (state.open) {
    set({ ...state, open: false })
  }
}

export function togglePalette(): void {
  if (state.open) {
    closePalette()
  } else {
    openPalette()
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const usePalette = (): PaletteState => useSyncExternalStore(subscribe, () => state)

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform)

/** How the palette key reads on this device. */
export const PALETTE_SHORTCUT = isMac() ? 'Cmd+K' : 'Ctrl+K'

/** Cmd+K on Apple devices, Ctrl+K elsewhere, so Ctrl+K keeps its line editing role on a Mac. */
export function isPaletteShortcut(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  mac = isMac(),
): boolean {
  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return e.code === 'KeyK' && primary && !e.altKey && !e.shiftKey
}
