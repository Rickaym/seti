import type { Task, WorkspaceEntry } from '@seti/shared'
import { useEffect, useLayoutEffect, useMemo } from 'react'
import { useCurrentWorkspace } from '@/hooks/useWorkspaces'
import { showLayoutsWorkspace } from '@/panels/tasks/agents-layouts'
import { followAgent, useFollowedAgent } from './workspace-store'

interface ShownWorkspace<T, A> {
  workspaces: readonly WorkspaceEntry[]
  shown: WorkspaceEntry | null
  /** Null until Seti says which workspace to show. */
  shownId: string | null
  tasks: T[]
  archived: A[]
}

/**
 * The workspace the agent list shows, with its agents. An agent opened from elsewhere, such as
 * the palette or a link, or moved while open, takes the list to its workspace in the same render.
 */
export function useShownWorkspace<T extends Pick<Task, 'workspace_id'>, A extends Pick<Task, 'workspace_id'>>(
  open: Pick<Task, 'id' | 'workspace_id'> | undefined,
  tasks: readonly T[],
  archived: readonly A[],
): ShownWorkspace<T, A> {
  const { workspaces, currentId } = useCurrentWorkspace()
  const followed = useFollowedAgent()
  const key = open === undefined ? null : `${open.id}/${open.workspace_id}`
  const target = open !== undefined && key !== followed && open.workspace_id !== currentId ? open.workspace_id : null
  const shownId = target ?? currentId
  const first = workspaces[0]?.id ?? null
  useLayoutEffect(() => {
    if (key !== followed) {
      followAgent(key, target)
    }
  }, [key, followed, target])
  useLayoutEffect(() => {
    if (shownId !== null) {
      showLayoutsWorkspace(shownId, first)
    }
  }, [shownId, first])
  useEffect(
    () => () => {
      followAgent(null, null)
    },
    [],
  )
  return useMemo(
    () => ({
      workspaces,
      shown: workspaces.find((workspace) => workspace.id === shownId) ?? null,
      shownId,
      tasks: tasks.filter((task) => task.workspace_id === shownId),
      archived: archived.filter((task) => task.workspace_id === shownId),
    }),
    [workspaces, shownId, tasks, archived],
  )
}
