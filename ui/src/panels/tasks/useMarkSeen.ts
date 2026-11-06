import type { Task, TaskStatus } from '@seti/shared'
import { useEffect } from 'react'
import { apiPost } from '@/api'
import { usePageVisible } from '@/hooks/usePageVisible'
import { refreshTasks } from '@/hooks/useTasks'

/**
 * Tells Seti the user saw the agent while its view is on a visible page and no turn runs: on
 * opening an unseen agent, and each time a turn ends in front of the user.
 */
export function useMarkSeen(
  task: Pick<Task, 'id' | 'unseen'>,
  status: TaskStatus,
  liveStatus: TaskStatus | null,
): void {
  const visible = usePageVisible()
  const due = visible && status !== 'running' && (task.unseen || liveStatus !== null)
  useEffect(() => {
    if (due) {
      apiPost(`/tasks/${task.id}/seen`)
        .then(refreshTasks)
        .catch(() => undefined)
    }
  }, [task.id, due])
}
