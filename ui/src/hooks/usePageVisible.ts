import { useSyncExternalStore } from 'react'

const subscribe = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => {
    document.removeEventListener('visibilitychange', listener)
  }
}

const visible = () => document.visibilityState === 'visible'

/** Whether the page is on screen: false while its tab sits in the background or minimised. */
export const usePageVisible = (): boolean => useSyncExternalStore(subscribe, visible)
