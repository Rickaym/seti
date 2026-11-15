import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { useRequests } from '@/hooks/useRequests'
import { mayLeave } from '@/lib/leave-guard'
import { navigate } from '@/lib/route'
import type { FilesPane } from '@/panels/files/useFilesPane'
import { holdRequests, onRequestsHeld, takeRequests } from '@/panels/requests/open-requests'

export interface RequestsPane {
  open: boolean
  toggle: () => void
  close: () => void
}

/**
 * Whether the agent's Requests drawer is open. It shares the side pane with Files one at a
 * time: opening it closes Files once any unsaved edit may go, and a file opening closes it.
 */
export function useRequestsPane(taskId: string, files: FilesPane): RequestsPane {
  const [open, setOpenState] = useState(false)
  const [seenRequest, setSeenRequest] = useState(files.request)
  if (files.request !== seenRequest) {
    setSeenRequest(files.request)
    if (files.request !== null) {
      setOpenState(false)
    }
  }
  const show = () => {
    if (files.request === null) {
      setOpenState(true)
      return
    }
    void mayLeave().then((ok) => {
      if (ok) {
        files.close()
        setOpenState(true)
      }
    })
  }
  const close = useCallback(() => {
    setOpenState(false)
  }, [])
  const showHeld = useEffectEvent(show)
  useEffect(() => {
    const take = () => {
      if (takeRequests(taskId)) {
        showHeld()
      }
    }
    take()
    return onRequestsHeld(take)
  }, [taskId])
  return {
    open,
    toggle: () => {
      if (open) {
        close()
      } else {
        show()
      }
    },
    close,
  }
}

/**
 * Opens an agent from Needs you, with its Requests drawer open while it asks a question; tool
 * calls, plans and access changes already wait at the end of its chat.
 */
export function useOpenFromNeedsYou(): (taskId: string) => void {
  const { requests } = useRequests()
  return (taskId) => {
    if (requests.questions.some((question) => question.task_id === taskId)) {
      holdRequests(taskId)
    }
    navigate('agents', taskId)
  }
}
