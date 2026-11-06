import { workspaceListSchema, type WorkspaceEntry } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'
import { resolveWorkspace, useChosenWorkspace } from '@/panels/tasks/workspaces/workspace-store'

const NONE: readonly WorkspaceEntry[] = []

const workspacesResource = createPolledResource('/workspaces', 30_000, { schema: workspaceListSchema })

export const refreshWorkspaces = (): void => {
  workspacesResource.refresh()
}

export interface CurrentWorkspace {
  workspaces: readonly WorkspaceEntry[]
  /** The workspace this device shows; null until the list loads. */
  current: WorkspaceEntry | null
  /** The id agents are filtered by: the chosen one before the list loads, null when unknown. */
  currentId: string | null
  loaded: boolean
}

/** The workspaces and the one this device shows, which falls back to the first. */
export function useCurrentWorkspace(): CurrentWorkspace {
  const { data } = usePolled(workspacesResource)
  const chosen = useChosenWorkspace()
  const workspaces = data ?? NONE
  const current = resolveWorkspace(workspaces, chosen)
  return {
    workspaces,
    current,
    currentId: data === undefined ? chosen : (current?.id ?? null),
    loaded: data !== undefined,
  }
}
