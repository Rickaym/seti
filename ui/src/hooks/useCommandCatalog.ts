import type { CommandCatalog } from '@seti/shared'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { apiGet } from '@/api'
import { CommandCatalogStore, IDLE_COMMANDS, type CommandState } from '@/lib/command-catalog'

const store = new CommandCatalogStore(async (path) => apiGet<CommandCatalog>(path))

/** Slash commands from an API path, loaded the first time `wanted` holds and shared by callers. */
export function useCommandCatalog(path: string | null, wanted: boolean): CommandState {
  const snapshot = useCallback(() => (path === null ? undefined : store.get(path)), [path])
  const entry = useSyncExternalStore(store.subscribe, snapshot)
  useEffect(() => {
    if (wanted && path !== null) {
      store.request(path)
    }
  }, [path, wanted])
  return entry ?? IDLE_COMMANDS
}
