import type {
  AgentTodo,
  MessagePage,
  MessageRow,
  OwnMessageStep,
  ShellProgress,
  SubtaskBrief,
  Task,
  TaskSession,
  TaskStatus,
} from '@seti/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { refreshTasks } from '@/hooks/useTasks'
import { openEventStream, type LiveEventStream } from '@/lib/event-stream'
import { noteMcpReport } from '@/lib/mcp-reports'
import type { OwnDirection } from '@/lib/own-messages'
import { mergeBriefs } from '@/lib/subtasks'
import { mergeRows, replaceRow } from '@/lib/transcript'
import { cachedTranscript, cacheTranscript, withBacklog, type LoadedRows as Loaded } from '@/lib/transcript-cache'
import type { TranscriptWindow } from '@/panels/tasks/TranscriptPane'

export interface TaskStream extends Loaded {
  /** Rows are showing: the stream sent its first page, or this session cached the transcript. */
  ready: boolean
  /** The stream sent its first page since this view opened, so rows are not only a cached copy. */
  fresh: boolean
  /** The stream failed before its first page arrived; it keeps retrying in the background. */
  failed: boolean
  retry: () => void
  /** Refetches the newest messages and the status, then reopens the stream. */
  resync: () => void
  status: TaskStatus | null
  /** The `!` command running now, or null. */
  shell: ShellProgress | null
  loadingOlder: boolean
  /** Counts the times Seti linked a PR to the task while the stream was open. */
  prLinks: number
  /** Counts the stream's reports of permission requests made, answered or dropped. */
  permissions: number
  subtasks: readonly SubtaskBrief[]
  /** The agent's todo list as the stream last reported it; null until it does. */
  todos: readonly AgentTodo[] | null
  /** The task's Claude Code process, as the stream last reported it. */
  session: TaskSession
  /** Whether the task was archived or restored while the stream was open; null until then. */
  archived: boolean | null
  /** Loads `limit` rows before the oldest loaded message; resolves false when nothing was added. */
  loadOlder: (limit?: number) => Promise<boolean>
  /** A stretch far back that find jumped to; new messages keep arriving behind it meanwhile. */
  stretch: TranscriptWindow
  /** Shows the stretch around a message, fetching it unless it is loaded already. */
  jumpTo: (id: number) => Promise<void>
  backToLatest: () => void
  /** The user's nearest own message past the loaded row `from`, found in the database. */
  findOwn: (direction: OwnDirection, from: number) => Promise<OwnMessageStep>
}

/** Messages around a jump far back; `hasNewer` stays true until it rejoins the newest ones. */
interface Detached extends Loaded {
  hasNewer: boolean
}

const WINDOW = 100

const EMPTY: Loaded = { messages: [], hasOlder: false }
const NO_SUBTASKS: readonly SubtaskBrief[] = []
const NO_SESSION: TaskSession = { open: false, background: 0 }

/** Drops the live shell entry once its finished row has arrived. */
const settled = (shell: ShellProgress | null, rows: readonly MessageRow[]) =>
  shell !== null && rows.some((row) => row.kind === 'shell' && row.payload.run_id === shell.run_id) ? null : shell

function merged(prev: Loaded, rows: readonly MessageRow[], hasOlder = prev.hasOlder): Loaded {
  const messages = mergeRows(prev.messages, rows)
  return messages === prev.messages && hasOlder === prev.hasOlder ? prev : { messages, hasOlder }
}

/** The newest messages of one task, live updates and earlier pages on demand. Remount per task id. */
export function useTaskStream(taskId: string): TaskStream {
  const [cached] = useState(() => cachedTranscript(taskId))
  const [loaded, setLoaded] = useState<Loaded>(cached?.rows ?? EMPTY)
  const [ready, setReady] = useState(cached !== undefined)
  /** The id of the last stream event `loaded` includes, set in the same update as the rows. */
  const [cursor, setCursor] = useState(cached?.cursor ?? null)
  const [fresh, setFresh] = useState(false)
  const [failed, setFailed] = useState(false)
  const live = useRef<LiveEventStream | null>(null)
  const [status, setStatus] = useState<TaskStatus | null>(null)
  const [shell, setShell] = useState<ShellProgress | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [prLinks, setPrLinks] = useState(0)
  const [permissions, setPermissions] = useState(0)
  const [subtasks, setSubtasks] = useState(NO_SUBTASKS)
  const [todos, setTodos] = useState<readonly AgentTodo[] | null>(null)
  const [session, setSession] = useState(NO_SESSION)
  const [archived, setArchived] = useState<boolean | null>(null)
  const [detached, setDetached] = useState<Detached | null>(null)
  const [loadingNewer, setLoadingNewer] = useState(false)
  const [latestRequest, setLatestRequest] = useState(0)
  const loading = useRef(false)

  useEffect(() => {
    let open = true
    const rowsUpTo = (event: MessageEvent<string>) => {
      setCursor(event.lastEventId === '' ? null : event.lastEventId)
    }
    const stream = openEventStream(
      `/tasks/${taskId}/stream`,
      {
        onConnected: (connected) => {
          if (open) {
            setFailed(!connected)
          }
        },
        events: {
          backlog: (event) => {
            const page = JSON.parse(event.data) as MessagePage
            setLoaded({ messages: page.messages, hasOlder: page.has_older })
            rowsUpTo(event)
            setReady(true)
            setFresh(true)
            setShell((prev) => settled(prev, page.messages))
          },
          message: (event) => {
            const row = JSON.parse(event.data) as MessageRow
            setLoaded((prev) => merged(prev, [row]))
            rowsUpTo(event)
            setShell((prev) => settled(prev, [row]))
          },
          updated: (event) => {
            const row = JSON.parse(event.data) as MessageRow
            const replace = <T extends Loaded>(prev: T): T => {
              const messages = replaceRow(prev.messages, row)
              return messages === prev.messages ? prev : { ...prev, messages }
            }
            setLoaded(replace)
            rowsUpTo(event)
            setDetached((prev) => prev && replace(prev))
          },
          shell: (event) => {
            setShell(JSON.parse(event.data) as ShellProgress)
          },
          prs: () => {
            setPrLinks((count) => count + 1)
          },
          permission: () => {
            setPermissions((count) => count + 1)
            refreshTasks()
          },
          blocked: () => {
            setPermissions((count) => count + 1)
            refreshTasks()
          },
          mcp: () => {
            noteMcpReport(taskId)
          },
          status: (event) => {
            setStatus((JSON.parse(event.data) as { status: TaskStatus }).status)
          },
          resumed: (event) => {
            const now = (JSON.parse(event.data) as { status: TaskStatus }).status
            // Only a status the stream reported can be stale; otherwise the task list's stands.
            setStatus((prev) => (prev === null ? prev : now))
            setFresh(true)
          },
          subtasks: (event) => {
            const next = JSON.parse(event.data) as SubtaskBrief[]
            setSubtasks((prev) => mergeBriefs(prev, next))
          },
          todos: (event) => {
            setTodos(JSON.parse(event.data) as AgentTodo[])
          },
          session: (event) => {
            setSession(JSON.parse(event.data) as TaskSession)
          },
          archived: (event) => {
            setArchived((JSON.parse(event.data) as { archived: boolean }).archived)
          },
        },
      },
      { after: cached?.cursor ?? null, parkWhenHidden: true },
    )
    live.current = stream
    return () => {
      open = false
      live.current = null
      stream.close()
    }
  }, [taskId, cached])

  useEffect(() => {
    if (ready) {
      cacheTranscript(taskId, loaded, cursor)
    }
  }, [taskId, loaded, cursor, ready])

  const retry = useCallback(() => {
    setFailed(false)
    live.current?.reconnect()
  }, [])

  const resync = useCallback(() => {
    Promise.all([apiGet<MessagePage>(`/tasks/${taskId}/messages`), apiGet<Task>(`/tasks/${taskId}`)])
      .then(([page, task]) => {
        setLoaded((prev) => withBacklog(prev, page))
        setStatus(task.status)
        live.current?.reconnect()
      })
      .catch(() => undefined)
  }, [taskId])

  const shown = detached ?? loaded
  const oldest = shown.messages[0]?.id
  const isDetached = detached !== null
  const loadOlder = useCallback(
    async (limit?: number) => {
      if (loading.current || oldest === undefined) {
        return false
      }
      loading.current = true
      setLoadingOlder(true)
      try {
        const size = limit === undefined ? '' : `&limit=${String(limit)}`
        const page = await apiGet<MessagePage>(`/tasks/${taskId}/messages?before=${String(oldest)}${size}`)
        if (isDetached) {
          setDetached((prev) => prev && { ...merged(prev, page.messages, page.has_older), hasNewer: prev.hasNewer })
        } else {
          setLoaded((prev) => merged(prev, page.messages, page.has_older))
        }
        return page.messages.length > 0
      } catch (e) {
        toast.error(errorText(e))
        return false
      } finally {
        loading.current = false
        setLoadingOlder(false)
      }
    },
    [taskId, oldest, isDetached],
  )

  /** Joins a stretch that reached the newest messages back onto them. */
  const rejoin = useCallback((rows: readonly MessageRow[], hasOlder: boolean) => {
    setLoaded((prev) => ({ messages: mergeRows(prev.messages, rows), hasOlder }))
    setDetached(null)
  }, [])

  const newest = detached?.messages.at(-1)?.id
  const loadNewer = useCallback(
    async (limit = WINDOW) => {
      if (loading.current || detached === null || newest === undefined) {
        return false
      }
      loading.current = true
      setLoadingNewer(true)
      try {
        const page = await apiGet<MessagePage>(
          `/tasks/${taskId}/messages?after=${String(newest)}&limit=${String(limit)}`,
        )
        if (page.has_newer === true) {
          setDetached((prev) => prev && { ...merged(prev, page.messages), hasNewer: true })
        } else {
          rejoin(mergeRows(detached.messages, page.messages), detached.hasOlder)
        }
        return page.messages.length > 0
      } catch (e) {
        toast.error(errorText(e))
        return false
      } finally {
        loading.current = false
        setLoadingNewer(false)
      }
    },
    [taskId, newest, detached, rejoin],
  )

  const latestOldest = loaded.messages[0]?.id
  const jumpTo = useCallback(
    async (id: number) => {
      if (latestOldest !== undefined && id >= latestOldest) {
        setDetached(null)
        return
      }
      const first = detached?.messages[0]?.id
      const last = detached?.messages.at(-1)?.id
      if (first !== undefined && last !== undefined && id >= first && id <= last) {
        return
      }
      try {
        const page = await apiGet<MessagePage>(`/tasks/${taskId}/messages?around=${String(id)}&limit=${String(WINDOW)}`)
        if (page.has_newer === true) {
          setDetached({ messages: page.messages, hasOlder: page.has_older, hasNewer: true })
        } else {
          rejoin(page.messages, page.has_older)
        }
      } catch (e) {
        toast.error(errorText(e))
      }
    },
    [taskId, latestOldest, detached, rejoin],
  )

  const findOwn = useCallback(
    async (direction: OwnDirection, from: number) =>
      apiGet<OwnMessageStep>(
        `/tasks/${taskId}/own-message?${direction === 'back' ? 'before' : 'after'}=${String(from)}`,
      ),
    [taskId],
  )

  const backToLatest = useCallback(() => {
    setDetached(null)
    setLatestRequest((value) => value + 1)
  }, [])

  return {
    ...shown,
    ready,
    fresh,
    failed: failed && !ready,
    retry,
    resync,
    status,
    shell,
    loadingOlder,
    prLinks,
    permissions,
    subtasks,
    todos,
    session,
    archived,
    loadOlder,
    stretch: {
      detached: isDetached,
      hasNewer: detached?.hasNewer ?? false,
      loadingNewer,
      loadNewer,
      backToLatest,
      latestRequest,
    },
    jumpTo,
    backToLatest,
    findOwn,
  }
}
