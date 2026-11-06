import { useEffect, useRef, type RefObject } from 'react'
import { useCommandScope } from '@/components/palette/command-scope'
import { hookTakesEscape } from '@/lib/input-hooks'

const DOUBLE_PRESS_MS = 500

interface EscapeKeys {
  /** Presses count while focus is inside this element, or nowhere in particular. */
  root: RefObject<HTMLElement | null>
  /** A turn or shell command is running, so Esc stops it. */
  busy: boolean
  /** A promise lets Esc stop again once it settles, as a turn for queued messages may run on. */
  onStop: () => Promise<void> | void
  /** Esc twice while idle; without it a double press does nothing. */
  onRewind?: () => void
}

const inside = (root: HTMLElement | null, target: EventTarget | null) =>
  root !== null && target instanceof Node && (target === document.body || root.contains(target))

/** Esc stops what runs, Esc twice while idle rewinds; dialogs win, inactive scopes ignore it. */
export function useEscapeKeys({ root, busy, onStop, onRewind }: EscapeKeys): void {
  const active = useCommandScope()
  const lastPress = useRef(Number.NEGATIVE_INFINITY)
  const stopping = useRef(false)

  useEffect(() => {
    if (!busy) {
      stopping.current = false
    }
  }, [busy])

  useEffect(() => {
    if (!active) {
      return undefined
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        e.repeat ||
        !inside(root.current, e.target) ||
        hookTakesEscape(e)
      ) {
        return
      }
      if (busy) {
        e.preventDefault()
        lastPress.current = Number.NEGATIVE_INFINITY
        if (!stopping.current) {
          stopping.current = true
          const done = onStop()
          if (done instanceof Promise) {
            void done.finally(() => {
              stopping.current = false
            })
          }
        }
        return
      }
      if (onRewind === undefined) {
        return
      }
      if (e.timeStamp - lastPress.current <= DOUBLE_PRESS_MS) {
        e.preventDefault()
        lastPress.current = Number.NEGATIVE_INFINITY
        onRewind()
      } else {
        lastPress.current = e.timeStamp
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [active, root, busy, onStop, onRewind])
}
