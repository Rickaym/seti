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
 * The editor keys for find in `root`: they run here before the Files search and the chat find,
 * which skip a key already handled. Keys the text does not offer pass through.
 */
export function useFindKeys(root: HTMLElement | null, find: FindState, offers: FindOffers): void {
  const latest = useRef({ find, offers })
  useLayoutEffect(() => {
    latest.current = { find, offers }
  })
  useEffect(() => {
    if (root === null) {
      return undefined
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) {
        return
      }
      const { find: now, offers: can } = latest.current
      if (e.key === 'Escape' && now.mode !== null) {
        e.preventDefault()
        now.close()
        return
      }
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
