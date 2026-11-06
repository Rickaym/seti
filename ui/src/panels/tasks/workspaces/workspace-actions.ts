import type { Task, Workspace } from '@seti/shared'
import { toast } from 'sonner'
import { apiDelete, apiPatch, apiPost, errorText } from '@/api'
import { refreshTaskLists } from '@/hooks/useTasks'
import { refreshWorkspaces } from '@/hooks/useWorkspaces'
import { mayLeave } from '@/lib/leave-guard'
import { navigate } from '@/lib/route'
import { chooseWorkspace } from './workspace-store'

/** Shows workspace `id` and its agent list, once any unsaved edit agrees to leave. */
export function switchWorkspace(id: string): void {
  void mayLeave().then((ok) => {
    if (ok) {
      chooseWorkspace(id)
      navigate('agents', undefined, { force: true })
    }
  })
}

/** Creates a workspace and switches to it; false when the server refused. */
export async function createWorkspace(name: string): Promise<boolean> {
  try {
    const created = await apiPost<Workspace>('/workspaces', { name })
    refreshWorkspaces()
    switchWorkspace(created.id)
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  }
}

export async function renameWorkspace(id: string, name: string): Promise<boolean> {
  try {
    await apiPatch<Workspace>(`/workspaces/${id}`, { name })
    refreshWorkspaces()
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  }
}

/** Deletes an empty workspace; the server says why it keeps one that holds agents. */
export async function deleteWorkspace(workspace: Workspace): Promise<void> {
  try {
    await apiDelete(`/workspaces/${workspace.id}`)
    refreshWorkspaces()
    toast.success(`Deleted workspace "${workspace.name}"`)
  } catch (e) {
    toast.error(errorText(e))
  }
}

/** Moves an agent to another workspace, archived or not. */
export async function moveAgent(task: Pick<Task, 'id'>, workspace: Workspace): Promise<void> {
  try {
    await apiPatch<Task>(`/tasks/${task.id}`, { workspace_id: workspace.id })
    toast.success(`Moved to ${workspace.name}`)
    refreshTaskLists()
    refreshWorkspaces()
  } catch (e) {
    toast.error(errorText(e))
  }
}
