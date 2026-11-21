import { hearsWorkspace } from '@seti/shared'
import { useCallback, useEffect } from 'react'
import { useCurrentWorkspace } from '@/hooks/useWorkspaces'
import { demoResetsAt } from '@/lib/demo'
import { reportWorkspace, useStoredScope } from '@/lib/notify-scope'

/** Whether this device's notifications keep to its open workspace; on until Seti says otherwise. */
export const useWorkspaceOnly = (): boolean => useStoredScope()?.workspace_only ?? true

export interface PageScope {
  /** False until Seti answered with this device's setting and the workspaces loaded. */
  ready: boolean
  /** Whether this page interrupts the user about an agent in the workspace. */
  hears: (workspaceId: string) => boolean
}

/** What this page raises toasts and sounds about: the open workspace, or all with the setting off. */
export function useNotifyScope(): PageScope {
  const known = useStoredScope()
  const { currentId, loaded } = useCurrentWorkspace()
  const only = known?.workspace_only ?? true
  const hears = useCallback(
    (workspaceId: string) => hearsWorkspace({ workspace_id: currentId, workspace_only: only }, workspaceId),
    [currentId, only],
  )
  return { ready: known !== null && loaded, hears }
}

/**
 * Tells Seti the workspace this page shows: once when the page loads, then when the workspace
 * changes or the page shows again while the device last reported another one, so the tab the
 * user looks at decides what the device is notified about. The public demo has no devices, so
 * its pages do not report.
 */
export function useWorkspaceReport(): void {
  const { current } = useCurrentWorkspace()
  const id = current?.id ?? null
  useEffect(() => {
    if (id === null || demoResetsAt() !== null) {
      return undefined
    }
    const report = () => {
      if (document.visibilityState === 'visible') {
        reportWorkspace(id)
      }
    }
    report()
    document.addEventListener('visibilitychange', report)
    return () => {
      document.removeEventListener('visibilitychange', report)
    }
  }, [id])
}
