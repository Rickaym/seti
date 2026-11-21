import type { NotifyScope, NotifyScopeInput } from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { apiPut } from '@/api'
import { deviceId } from '@/lib/device'

/** This device's scope as the server last answered it; null until it has. */
let scope: NotifyScope | null = null
/** The workspace a report in flight carries. */
let sending: string | null = null
const listeners = new Set<() => void>()

/** The workspace this browser last told Seti it shows; its tabs share it like the device id. */
const REPORTED_KEY = 'seti.notify.reported'

function lastReported(): string | null {
  try {
    return localStorage.getItem(REPORTED_KEY)
  } catch {
    return null
  }
}

function remember(workspaceId: string | null): void {
  try {
    if (workspaceId === null) {
      localStorage.removeItem(REPORTED_KEY)
    } else {
      localStorage.setItem(REPORTED_KEY, workspaceId)
    }
  } catch {
    // Storage can be blocked; this page then reports each time it shows.
  }
}

export interface ReportState {
  /** This page has an answer from Seti, so it knows the device's setting. */
  answered: boolean
  sending: string | null
  reported: string | null
}

/**
 * Whether reporting `workspaceId` tells Seti anything new: the first report of a page always
 * does, since its answer carries the setting; later ones only when the device last reported
 * another workspace, from this tab or another.
 */
export const reportNeeded = (workspaceId: string, state: ReportState): boolean =>
  state.sending !== workspaceId && (!state.answered || state.reported !== workspaceId)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

async function change(input: NotifyScopeInput): Promise<void> {
  scope = await apiPut<NotifyScope>(`/notifications/devices/${deviceId()}/scope`, input)
  remember(scope.workspace_id)
  for (const listener of listeners) {
    listener()
  }
}

/** Tells Seti which workspace this device shows, so push for other workspaces can skip it. */
export function reportWorkspace(workspaceId: string): void {
  if (!reportNeeded(workspaceId, { answered: scope !== null, sending, reported: lastReported() })) {
    return
  }
  sending = workspaceId
  change({ workspace_id: workspaceId })
    .catch(() => {
      // The page reports again when it next shows or switches; until then the last report stands.
    })
    .finally(() => {
      if (sending === workspaceId) {
        sending = null
      }
    })
}

/** Turns "Active workspace only" on or off for this device; throws when Seti refuses. */
export const setWorkspaceOnly = async (on: boolean): Promise<void> => change({ workspace_only: on })

/** This device's scope as Seti last answered it; null until it has. */
export const useStoredScope = (): NotifyScope | null => useSyncExternalStore(subscribe, () => scope)
