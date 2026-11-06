import type { MessagePage, MessageRow, SubtaskBrief, TaskStatus } from '@seti/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { openEventStream } from '@/lib/event-stream'
import { mergeBriefs } from '@/lib/subtasks'
import { mergeRows, routedSubagentOf, subagentOf } from '@/lib/transcript'
import type { TranscriptSource } from '@/panels/tasks/TranscriptPane'

const PAGE = 150
const NO_SUBTASKS: readonly SubtaskBrief[] = []

export interface SubtaskStream extends TranscriptSource {
  /** Every subtask of the task, kept current by the task's stream. */
  subtasks: readonly SubtaskBrief[]
  /** The task's status once the stream reported one. */
  status: TaskStatus | null
  ready: boolean
  failed: boolean
  retry: () => void
}

interface Loaded {
  messages: readonly MessageRow[]
  hasOlder: boolean
}

const EMPTY: Loaded = { messages: [], hasOlder: false }

/**
 * The transcript of one subtask: its newest page, earlier pages on demand, and new rows as
 * the task's stream carries them. Remount per subtask.
 */
export function useSubtaskStream(taskId: string, toolUseId: string): SubtaskStream {
  const [loaded, setLoaded] = useState<Loaded>(EMPTY)
  const [subtasks, setSubtasks] = useState(NO_SUBTASKS)
  const [status, setStatus] = useState<TaskStatus | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [first, setFirst] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)
  const own = useRef(new Set([toolUseId]))
  const loading = useRef(false)
  const base = `/tasks/${taskId}/subtasks/${toolUseId}/messages`

  const add = useCallback((rows: readonly MessageRow[], hasOlder?: boolean) => {
    setLoaded((prev) => {
      const messages = mergeRows(prev.messages, rows)
      const older = hasOlder ?? prev.hasOlder
      return messages === prev.messages && older === prev.hasOlder ? prev : { messages, hasOlder: older }
    })
  }, [])

  useEffect(() => {
    const keep = (rows: readonly MessageRow[]) =>
      rows.filter((row) => own.current.has(subagentOf(row) ?? routedSubagentOf(row) ?? ''))
    let opened = false
    const stream = openEventStream(
      `/tasks/${taskId}/stream?tail=1`,
      {
        events: {
          backlog: (event) => {
            add(keep((JSON.parse(event.data) as MessagePage).messages))
            if (opened) {
              // A later backlog means the stream could not catch up, so fetch what it skipped.
              setAttempt((n) => n + 1)
            }
            opened = true
          },
          message: (event) => {
            add(keep([JSON.parse(event.data) as MessageRow]))
          },
          status: (event) => {
            setStatus((JSON.parse(event.data) as { status: TaskStatus }).status)
          },
          resumed: (event) => {
            setStatus((JSON.parse(event.data) as { status: TaskStatus }).status)
          },
          subtasks: (event) => {
            const next = JSON.parse(event.data) as SubtaskBrief[]
            const mine = next.find((subtask) => subtask.tool_use_id === toolUseId)
            own.current = new Set(mine?.tool_use_ids ?? [toolUseId])
            setSubtasks((prev) => mergeBriefs(prev, next))
          },
        },
      },
      { parkWhenHidden: true },
    )
    return () => {
      stream.close()
    }
  }, [taskId, toolUseId, add])

  useEffect(() => {
    let current = true
    apiGet<MessagePage>(`${base}?limit=${String(PAGE)}`).then(
      (page) => {
        if (current) {
          add(page.messages, page.has_older)
          setFirst('ready')
        }
      },
      () => {
        if (current) {
          setFirst('failed')
        }
      },
    )
    return () => {
      current = false
    }
  }, [base, attempt, add])

  const retry = useCallback(() => {
    setFirst('loading')
    setAttempt((n) => n + 1)
  }, [])

  const oldest = loaded.messages[0]?.id
  const loadOlder = useCallback(async () => {
    if (loading.current || oldest === undefined) {
      return false
    }
    loading.current = true
    setLoadingOlder(true)
    try {
      const page = await apiGet<MessagePage>(`${base}?before=${String(oldest)}`)
      setLoaded((prev) => ({ messages: mergeRows(prev.messages, page.messages), hasOlder: page.has_older }))
      return page.messages.length > 0
    } catch (e) {
      toast.error(errorText(e))
      return false
    } finally {
      loading.current = false
      setLoadingOlder(false)
    }
  }, [base, oldest])

  return {
    ...loaded,
    subtasks,
    status,
    ready: first === 'ready',
    failed: first === 'failed',
    retry,
    loadingOlder,
    loadOlder,
  }
}
