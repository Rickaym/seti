import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { useOpenQuestions } from '@/hooks/useQuestions'
import { mayLeave } from '@/lib/leave-guard'
import { navigate } from '@/lib/route'
import type { FilesPane } from '@/panels/files/useFilesPane'
import { holdQuestions, onQuestionsHeld, takeQuestions } from '@/panels/questions/open-questions'

export interface QuestionsPane {
  open: boolean
  toggle: () => void
  close: () => void
}

/**
 * Whether the agent's Questions drawer is open. It shares the side pane with Files one at a
 * time: opening it closes Files once any unsaved edit may go, and a file opening closes it.
 */
export function useQuestionsPane(taskId: string, files: FilesPane): QuestionsPane {
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
      if (takeQuestions(taskId)) {
        showHeld()
      }
    }
    take()
    return onQuestionsHeld(take)
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

/** Opens an agent from Needs you, with its Questions drawer open while it asks something. */
export function useOpenFromNeedsYou(): (taskId: string) => void {
  const open = useOpenQuestions()
  return (taskId) => {
    if (open.some((question) => question.task_id === taskId)) {
      holdQuestions(taskId)
    }
    navigate('agents', taskId)
  }
}
