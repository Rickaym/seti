import type { NotifyScope, NotifyScopeInput } from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { apiPut } from '@/api'
import { deviceId } from '@/lib/device'

/** This device's scope as the server last answered it; null until it has. */
let scope: NotifyScope | null = null
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

async function change(input: NotifyScopeInput): Promise<void> {
  scope = await apiPut<NotifyScope>(`/notifications/devices/${deviceId()}/scope`, input)
  for (const listener of listeners) {
    listener()
  }
}

/** Tells Seti which workspace this device shows, so push for other workspaces can skip it. */
export function reportWorkspace(workspaceId: string): void {
  change({ workspace_id: workspaceId }).catch(() => {
    // The page reports again when it next shows or switches; until then the last report stands.
  })
}

/** Turns "Active workspace only" on or off for this device; throws when Seti refuses. */
export const setWorkspaceOnly = async (on: boolean): Promise<void> => change({ workspace_only: on })

/** This device's scope as Seti last answered it; null until it has. */
export const useStoredScope = (): NotifyScope | null => useSyncExternalStore(subscribe, () => scope)
