import { useSyncExternalStore } from 'react'

/** Whether this page has started the mods the server runs once, so their themes are known. */
let synced = false
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function markModsSynced(): void {
  if (!synced) {
    synced = true
    for (const listener of listeners) {
      listener()
    }
  }
}

export const useModsSynced = (): boolean => useSyncExternalStore(subscribe, () => synced)

let settling: Promise<void> = Promise.resolve()

/** Notes the starts and stops of mods under way, so a command can wait for its mod's UI half. */
export function trackModSync(work: Promise<void>): void {
  settling = work
}

/** Resolves once the mod starts and stops under way in this page have finished. */
export const modsSettled = async (): Promise<void> => settling
