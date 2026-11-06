import { createContext, useContext, useSyncExternalStore } from 'react'
import type { TeamChatStore, TeamState } from './team-store'

export const TeamChatContext = createContext<TeamChatStore | null>(null)

let shown: TeamChatStore | null = null

/** Makes `store` the one code outside React toggles; returns what withdraws it. */
export function offerGroupChat(store: TeamChatStore): () => void {
  shown = store
  return () => {
    if (shown === store) {
      shown = null
    }
  }
}

/** Opens or closes the group chat from code outside React, such as a mod's keys. */
export const toggleGroupChat = (): void => {
  shown?.toggle()
}

export function useTeamChatStore(): TeamChatStore {
  const store = useContext(TeamChatContext)
  if (!store) {
    throw new Error('useTeamChatStore must be used inside TeamChatProvider')
  }
  return store
}

export function useTeamChat(): TeamState {
  const store = useTeamChatStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export const isTeamShortcut = (e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>) =>
  e.code === 'KeyL' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey

export const TEAM_SHORTCUT = 'Ctrl+Shift+L'
