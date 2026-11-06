import { APPLE } from './terminal-clipboard'

/** Terminal font sizes in px: the default, and the smallest and largest a pinch or key reaches. */
export const DEFAULT_FONT = 13
const MIN_FONT = 8
const MAX_FONT = 28
const KEY = 'seti.terminal.fontSize'

export const clampFont = (size: number) => Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(size)))

/** The size a pinch reaches: the size it started at, scaled by how far the fingers spread. */
export const pinchFont = (start: number, scale: number) => clampFont(start * scale)

type FontKeys = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>

/**
 * The font change a key press asks for, as browsers zoom: Ctrl+= or Ctrl++ grows it, Ctrl+-
 * shrinks it, Ctrl+0 resets it; Cmd on a Mac. Null for any other key.
 */
export function fontChord(event: FontKeys, apple: boolean): 'grow' | 'shrink' | 'reset' | null {
  const held = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!held || event.altKey) {
    return null
  }
  if (event.key === '=' || event.key === '+') {
    return 'grow'
  }
  if (event.key === '-' || event.key === '_') {
    return 'shrink'
  }
  return event.key === '0' ? 'reset' : null
}

/** The size a chord leads to from `size`. */
export function chordFont(size: number, chord: 'grow' | 'shrink' | 'reset'): number {
  if (chord === 'reset') {
    return DEFAULT_FONT
  }
  return clampFont(size + (chord === 'grow' ? 1 : -1))
}

function stored(): number {
  try {
    const value = Number(localStorage.getItem(KEY))
    return Number.isFinite(value) && value > 0 ? clampFont(value) : DEFAULT_FONT
  } catch {
    return DEFAULT_FONT
  }
}

/** Takes the font chords from xterm and applies them; false for a key xterm must not handle. */
export function fontKeys(event: KeyboardEvent): boolean {
  const chord = fontChord(event, APPLE)
  if (chord === null) {
    return true
  }
  if (event.type === 'keydown') {
    event.preventDefault()
    terminalFont.set(chordFont(terminalFont.get(), chord))
  }
  return false
}

const listeners = new Set<() => void>()
let size: number | null = null

/** This device's terminal font size, shared by every terminal on the page and kept per device. */
export const terminalFont = {
  get(): number {
    size ??= stored()
    return size
  },
  set(next: number): void {
    const clamped = clampFont(next)
    if (clamped === terminalFont.get()) {
      return
    }
    size = clamped
    try {
      localStorage.setItem(KEY, String(clamped))
    } catch {
      // Storage can be blocked; the size then lasts until the page reloads.
    }
    for (const listener of listeners) {
      listener()
    }
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
