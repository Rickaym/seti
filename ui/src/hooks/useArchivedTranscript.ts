import type { MessagePage, MessageRow } from '@seti/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import type { TranscriptSource } from '@/panels/tasks/TranscriptPane'

const PAGE = 150

interface Loaded {
  messages: readonly MessageRow[]
  hasOlder: boolean
}

/** An archived agent's transcript, read page by page from its archive; nothing arrives live. */
export function useArchivedTranscript(
  taskId: string,
): TranscriptSource & { loaded: boolean; failed: boolean; retry: () => void } {
  const [state, setState] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const loading = useRef(false)

  useEffect(() => {
    let current = true
    apiGet<MessagePage>(`/tasks/${taskId}/messages?limit=${String(PAGE)}`).then(
      (page) => {
        if (current) {
          setState({ messages: page.messages, hasOlder: page.has_older })
        }
      },
      () => {
        if (current) {
          setFailed(true)
        }
      },
    )
    return () => {
      current = false
    }
  }, [taskId, attempt])

  const retry = useCallback(() => {
    setFailed(false)
    setAttempt((n) => n + 1)
  }, [])

  const oldest = state?.messages[0]?.id
  const loadOlder = useCallback(async () => {
    if (loading.current || oldest === undefined) {
      return false
    }
    loading.current = true
    setLoadingOlder(true)
    try {
      const page = await apiGet<MessagePage>(`/tasks/${taskId}/messages?limit=${String(PAGE)}&before=${String(oldest)}`)
      setState((prev) => ({ messages: [...page.messages, ...(prev?.messages ?? [])], hasOlder: page.has_older }))
      return page.messages.length > 0
    } catch (e) {
      toast.error(errorText(e))
      return false
    } finally {
      loading.current = false
      setLoadingOlder(false)
    }
  }, [taskId, oldest])

  return {
    messages: state?.messages ?? [],
    hasOlder: state?.hasOlder ?? false,
    loadingOlder,
    loadOlder,
    loaded: state !== null,
    failed,
    retry,
  }
}
