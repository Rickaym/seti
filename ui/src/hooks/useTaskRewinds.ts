import type { TaskRewind, TaskStatus } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'

const NONE: readonly TaskRewind[] = []

/** The rewinds of a task, loaded again whenever its status changes or reload is called. */
export function useTaskRewinds(taskId: string, status: TaskStatus) {
  const [rewinds, setRewinds] = useState<readonly TaskRewind[]>(NONE)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let current = true
    apiGet<TaskRewind[]>(`/tasks/${taskId}/rewinds`)
      .then((list) => {
        if (current) {
          setRewinds(list.length === 0 ? NONE : list)
        }
      })
      .catch((e: unknown) => toast.error(errorText(e)))
    return () => {
      current = false
    }
  }, [taskId, status, version])

  const reload = useCallback(() => {
    setVersion((v) => v + 1)
  }, [])

  return { rewinds, reload }
}
