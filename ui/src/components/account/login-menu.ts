import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

/** Opens or closes the status bar's login switcher, as its Alt chord and its trigger do. */
export function setLoginMenu(next: boolean): void {
  if (open !== next) {
    open = next
    for (const listener of listeners) {
      listener()
    }
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useLoginMenu = (): boolean => useSyncExternalStore(subscribe, () => open)
