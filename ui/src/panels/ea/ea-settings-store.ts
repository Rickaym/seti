import { useSyncExternalStore } from 'react'

let requested = false
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (requested !== next) {
    requested = next
    for (const listener of listeners) {
      listener()
    }
  }
}

/** Asks the EA settings popover to open, now or once the EA page mounts it. */
export const requestEaSettings = (): void => {
  set(true)
}

export const takeEaSettingsRequest = (): void => {
  set(false)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useEaSettingsRequested = (): boolean => useSyncExternalStore(subscribe, () => requested)
