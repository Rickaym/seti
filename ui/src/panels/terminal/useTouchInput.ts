import type { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Modifier } from './TerminalKeys'
import type { Held } from './terminal-keys'

const RELEASED: Held = { ctrl: false, alt: false }

/** The soft Ctrl and Alt: a tap turns one on for the next key, which turns it off again. */
export function useModifiers() {
  const [held, setHeld] = useState<Held>(RELEASED)
  const current = useRef(RELEASED)
  const set = useCallback((next: Held) => {
    current.current = next
    setHeld(next)
  }, [])
  const toggle = useCallback(
    (modifier: Modifier) => {
      set({ ...current.current, [modifier]: !current.current[modifier] })
    },
    [set],
  )
  const now = useCallback(() => current.current, [])
  const release = useCallback(() => {
    if (current.current.ctrl || current.current.alt) {
      set(RELEASED)
    }
  }, [set])
  /** The modifiers for one key, turned off as it takes them. */
  const take = useCallback(() => {
    const was = current.current
    release()
    return was
  }, [release])
  return { held, toggle, now, release, take }
}

export type Modifiers = ReturnType<typeof useModifiers>

/** The input line as the terminal around it drives it. */
export interface LineControl {
  focus: () => void
  /** Sends what the line holds and empties it, before a key from the key row goes out. */
  settle: () => void
}

/**
 * Focus for a terminal that types through its input line while `lined`: xterm's own textarea
 * hands focus on to the line, so a tap on the screen brings the keyboard up for the line.
 */
export function useLineFocus(term: Terminal | null, lined: boolean) {
  const line = useRef<LineControl>(null)
  const focusInput = useCallback(() => {
    if (line.current === null) {
      term?.focus()
    } else {
      line.current.focus()
    }
  }, [term])
  useEffect(() => {
    const textarea = term?.textarea
    if (textarea === undefined || !lined) {
      return undefined
    }
    const redirect = () => {
      line.current?.focus()
    }
    textarea.addEventListener('focus', redirect)
    return () => {
      textarea.removeEventListener('focus', redirect)
    }
  }, [term, lined])
  return { line, focusInput }
}
