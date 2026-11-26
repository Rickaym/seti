import type { Task } from '@seti/shared'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { refreshTaskLists } from '@/hooks/useTasks'

/** Renames the agent; false when the change failed. */
export async function renameTask(task: Pick<Task, 'id'>, title: string, onChanged: () => void): Promise<boolean> {
  try {
    await apiPatch<Task>(`/tasks/${task.id}`, { title })
    toast.success(`Renamed to "${title}"`)
    onChanged()
    refreshTaskLists()
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  }
}
