import { useEffect, useMemo, useState } from 'react'
import { mayLeave } from '@/lib/leave-guard'
import type { FilesRequest } from '@/panels/files/FilesPanel'
import type { FileLinks } from '@/panels/files/file-links'
import type { FileTarget } from '@/panels/files/files-api'
import { onPending, openInTask, takePending } from '@/panels/files/open-in-task'
import { createPathResolver } from '@/panels/files/path-resolver'

export interface FilesPane {
  /** What the open panel shows, or null while it is closed. */
  request: FilesRequest | null
  links: FileLinks
  setOpen: (open: boolean) => void
  close: () => void
}

/** Whether a task's Files panel is open and at what, and how its transcript opens files there. */
export function useFilesPane(taskId: string): FilesPane {
  const [request, setRequest] = useState<FilesRequest | null>(null)
  const links = useMemo<FileLinks>(
    () => ({
      taskId,
      resolver: createPathResolver(taskId),
      open: (target: FileTarget) => {
        if (target.task_id !== undefined && target.task_id !== taskId) {
          openInTask(target.task_id, target)
          return
        }
        setRequest((previous) => ({ target, seq: (previous?.seq ?? 0) + 1 }))
      },
    }),
    [taskId],
  )
  useEffect(() => {
    const take = () => {
      const target = takePending(taskId)
      if (target !== null) {
        setRequest((previous) => ({ target, seq: (previous?.seq ?? 0) + 1 }))
      }
    }
    take()
    return onPending(take)
  }, [taskId])
  return {
    request,
    links,
    setOpen: (open) => {
      if (open) {
        setRequest((previous) => ({ target: null, seq: (previous?.seq ?? 0) + 1 }))
        return
      }
      void mayLeave().then((ok) => {
        if (ok) {
          setRequest(null)
        }
      })
    },
    close: () => {
      setRequest(null)
    },
  }
}
