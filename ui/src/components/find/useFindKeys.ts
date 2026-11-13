import { useEffect, useLayoutEffect, useRef } from 'react'
import { textFindKey } from '@/components/find/find-keys'
import type { FindState } from '@/components/find/useFind'

/** Which find actions the text offers. */
export interface FindOffers {
  find: boolean
  replace: boolean
  line: boolean
}

/**
 * Esc inside `element` closes an open find before anything else hears it, such as a dialog
 * around it, which listens on the document while the key is still on its way down.
 */
export function useEscapeClosesFind(element: HTMLElement | null, find: FindState): void {
  const latest = useRef(find)
  useLayoutEffect(() => {
    latest.current = find
  })
  useEffect(() => {
    if (element === null) {
      return undefined
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const inside = e.target instanceof Node && element.contains(e.target)
      if (e.key === 'Escape' && !e.defaultPrevented && inside && latest.current.mode !== null) {
        e.preventDefault()
        latest.current.close()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [element])
}

/**
 * The editor keys for find in `root`: they run here before the Files search and the chat find,
 * which skip a key already handled. Keys the text does not offer pass through.
 */
export function useFindKeys(root: HTMLElement | null, find: FindState, offers: FindOffers): void {
  const latest = useRef({ find, offers })
  useLayoutEffect(() => {
    latest.current = { find, offers }
  })
  useEscapeClosesFind(root, find)
  useEffect(() => {
    if (root === null) {
      return undefined
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) {
        return
      }
      const { find: now, offers: can } = latest.current
      const action = textFindKey(e)
      if (action === null || !can.find || (action === 'replace' && !can.replace) || (action === 'line' && !can.line)) {
        return
      }
      e.preventDefault()
      if (action === 'next' || action === 'previous') {
        if (now.query === null) {
          now.open('find')
        } else {
          now.target.current?.[action]()
        }
        return
      }
      now.open(action)
    }
    root.addEventListener('keydown', onKeyDown)
    return () => {
      root.removeEventListener('keydown', onKeyDown)
    }
  }, [root])
}
