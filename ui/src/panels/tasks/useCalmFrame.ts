import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { AgentFrame } from '@/panels/tasks/agent-frame'

/**
 * Whether a framed agent view shows calm. It stays calm while `hold` is on, and opening it with
 * focus left nowhere, as a key press does, moves focus to the reply box.
 */
export function useCalmFrame(frame: AgentFrame | null, root: RefObject<HTMLElement | null>) {
  const [held, setHeld] = useState(false)
  const calm = frame !== null && (frame.calm === true || held)
  const was = useRef(calm)
  useEffect(() => {
    if (was.current && !calm && document.activeElement === document.body) {
      root.current?.querySelector<HTMLElement>('[data-primary-input="true"]')?.focus({ preventScroll: true })
    }
    was.current = calm
  }, [calm, root])
  const hold = useCallback((on: boolean) => {
    setHeld(on)
  }, [])
  return { calm, hold }
}
