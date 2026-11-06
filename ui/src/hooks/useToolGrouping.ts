import { useSyncExternalStore } from 'react'

const KEY = 'seti-ui-group-tools'

const listeners = new Set<() => void>()
let chosen = true

/** Whether transcripts fold runs of tool calls into groups; on unless turned off in this browser. */
function groupingEnabled(): boolean {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === null ? chosen : stored !== 'off'
  } catch {
    return chosen
  }
}

function setGroupingEnabled(enabled: boolean): void {
  chosen = enabled
  try {
    localStorage.setItem(KEY, enabled ? 'on' : 'off')
  } catch {
    // Blocked storage keeps the choice in memory for this visit.
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) {
      listener()
    }
  }
  listeners.add(listener)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The Group tool calls setting of this browser, and a setter every transcript follows at once. */
export function useToolGrouping(): [boolean, (enabled: boolean) => void] {
  return [useSyncExternalStore(subscribe, groupingEnabled), setGroupingEnabled]
}
