import { useSyncExternalStore } from 'react'

type VimMode = 'normal' | 'insert'

interface VimState {
  /** The mod is on and the screen shows panels; phones never take Vim keys. */
  active: boolean
  mode: VimMode
  helpOpen: boolean
}

let state: VimState = { active: false, mode: 'normal', helpOpen: false }
const listeners = new Set<() => void>()

function set(next: Partial<VimState>): void {
  const merged = { ...state, ...next }
  if ((Object.keys(next) as (keyof VimState)[]).every((key) => merged[key] === state[key])) {
    return
  }
  state = merged
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether Vim keys act now: the mod is on and the screen shows panels. */
export const vimActive = (): boolean => state.active

export const setVimActive = (active: boolean): void => {
  set({ active })
}

export const setVimMode = (mode: VimMode): void => {
  set({ mode })
}

export const setVimHelpOpen = (helpOpen: boolean): void => {
  set({ helpOpen })
}

export const useVimActive = (): boolean => useSyncExternalStore(subscribe, () => state.active)

export const useVimMode = (): VimMode => useSyncExternalStore(subscribe, () => state.mode)

export const useVimHelpOpen = (): boolean => useSyncExternalStore(subscribe, () => state.helpOpen)
