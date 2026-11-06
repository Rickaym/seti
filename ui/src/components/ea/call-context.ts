import { createContext, useContext, useSyncExternalStore } from 'react'
import type { AudioDeviceStore, AudioState } from './audio-store'
import type { AutoJoin, AutoJoinStatus } from './auto-join'
import type { CallState } from './call-state'
import type { EaCallStore } from './call-store'
import type { EaHistoryStore, HistoryState } from './history-store'

export const EaCallContext = createContext<EaCallStore | null>(null)
export const EaHistoryContext = createContext<EaHistoryStore | null>(null)
export const EaAudioContext = createContext<AudioDeviceStore | null>(null)
export const EaAutoJoinContext = createContext<AutoJoin | null>(null)

export function useEaCallStore(): EaCallStore {
  const store = useContext(EaCallContext)
  if (!store) {
    throw new Error('useEaCallStore must be used inside EaCallProvider')
  }
  return store
}

export function useEaCall(): CallState {
  const store = useEaCallStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export function useEaHistoryStore(): EaHistoryStore {
  const store = useContext(EaHistoryContext)
  if (!store) {
    throw new Error('useEaHistoryStore must be used inside EaCallProvider')
  }
  return store
}

export function useEaHistory(): HistoryState {
  const store = useEaHistoryStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export function useEaAudioStore(): AudioDeviceStore {
  const store = useContext(EaAudioContext)
  if (!store) {
    throw new Error('useEaAudioStore must be used inside EaCallProvider')
  }
  return store
}

export function useEaAudio(): AudioState {
  const store = useEaAudioStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export function useEaAutoJoin(): AutoJoin {
  const autoJoin = useContext(EaAutoJoinContext)
  if (!autoJoin) {
    throw new Error('useEaAutoJoin must be used inside EaCallProvider')
  }
  return autoJoin
}

export function useAutoJoinStatus(): AutoJoinStatus {
  const autoJoin = useEaAutoJoin()
  return useSyncExternalStore(autoJoin.subscribe, autoJoin.getSnapshot)
}
