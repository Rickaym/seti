import { isRecord } from '@seti/mod-api'
import { useSyncExternalStore } from 'react'

/** How this device shows the grid, apart from its layouts. */
export interface GridPrefs {
  /** Panels show the status and the latest message until one is opened. */
  calm: boolean
  /** The agents list hides while the grid shows. */
  listHidden: boolean
}

const PREFS_KEY = 'seti.agents.grid.prefs'

const DEFAULTS: GridPrefs = { calm: true, listHidden: false }

function readPrefs(): GridPrefs {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null')
    return isRecord(stored) ? { calm: stored.calm !== false, listHidden: stored.listHidden === true } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

let prefs = readPrefs()
const listeners = new Set<() => void>()

export const gridPrefs = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get: (): GridPrefs => prefs,
  set: (change: Partial<GridPrefs>) => {
    prefs = { ...prefs, ...change }
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // Storage can be blocked; the choice then lasts for this visit only.
    }
    for (const listener of listeners) {
      listener()
    }
  },
}

export const useGridPrefs = (): GridPrefs => useSyncExternalStore(gridPrefs.subscribe, gridPrefs.get)
