import type { Task } from '@seti/shared'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { refreshTaskLists } from '@/hooks/useTasks'

/** Pins or unpins the agent, with a toast either way. */
export function usePin(task: Task, onChanged: () => void): (pinned: boolean) => Promise<void> {
  return async (pinned: boolean) => {
    try {
      await apiPatch<Task>(`/tasks/${task.id}`, { pinned })
      toast.success(pinned ? `Pinned "${task.title}"` : `Unpinned "${task.title}"`)
      onChanged()
      refreshTaskLists()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
}
