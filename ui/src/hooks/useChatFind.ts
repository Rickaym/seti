import {
  normalizeSearchQuery,
  SEARCH_QUERY_MIN,
  type SearchHit,
  type SearchMode,
  type SearchResult,
} from '@seti/shared'
import { TextSearch } from 'lucide-react'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { useCommandScope } from '@/components/palette/command-scope'
import type { PaletteCommand } from '@/components/palette/registry'
import { useCommands } from '@/components/palette/useCommands'
import { FIND_SHORTCUT, openChatSearch, registerChatSearch, type ChatSearchTarget } from '@/components/shortcuts/find'
import type { FindMarks } from '@/hooks/useFindMarks'

const DEBOUNCE_MS = 250

export interface ChatFind {
  open: boolean
  query: string
  mode: SearchMode
  /** Whether hits include tool calls and their output; null in a chat that has none. */
  tools: boolean | null
  /** Newest first. */
  hits: readonly SearchHit[]
  /** More matches lie past the loaded hits. */
  hasMore: boolean
  /** The hit shown now, as an index into `hits`, or -1. */
  index: number
  current: SearchHit | null
  searching: boolean
  error: string | null
  /** Changes each time find is asked to open, so the bar can focus its field again. */
  focusRequest: number
  /** Changes each time find lands on a hit, so the view scrolls to it again. */
  step: number
  openFind: () => void
  close: () => void
  setQuery: (query: string) => void
  setMode: (mode: SearchMode) => void
  setTools: (tools: boolean) => void
  /** The next hit back in time, as Enter steps. */
  older: () => void
  /** The next hit forward in time, as Shift+Enter steps. */
  newer: () => void
}

/** The hits of one query; `key` names the query, so a stale answer never shows for a newer one. */
interface Found {
  key: string
  hits: readonly SearchHit[]
  hasMore: boolean
  index: number
  error: string | null
}

/** "3 of 100+", or what the field holds when there is no hit to count. */
export function findCount(find: Pick<ChatFind, 'query' | 'hits' | 'hasMore' | 'index' | 'searching'>): string {
  if (normalizeSearchQuery(find.query).length < SEARCH_QUERY_MIN) {
    return ''
  }
  if (find.hits.length === 0) {
    return find.searching ? '...' : 'No matches'
  }
  return `${String(find.index + 1)} of ${String(find.hits.length)}${find.hasMore ? '+' : ''}`
}

interface SearchParams {
  q: string
  mode: SearchMode
  tools: boolean
  before?: number
}

function searchUrl(path: string, { q, mode, tools, before }: SearchParams): string {
  const params = new URLSearchParams({ q, mode })
  if (tools) {
    params.set('tools', 'true')
  }
  if (before !== undefined) {
    params.set('before', String(before))
  }
  return `${path}?${params.toString()}`
}

/** Names one search, or null while find is closed or the query is too short to run. */
const searchKey = (open: boolean, q: string, parts: readonly string[]) =>
  open && q.length >= SEARCH_QUERY_MIN ? [...parts, q].join('\n') : null

/**
 * Find in one chat: debounced search against `path`, hits newest first and stepping through them.
 * With `toolRows`, the chat holds tool calls, which find skips unless the user turns them on.
 */
function useChatFind(path: string, toolRows: boolean): ChatFind {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('text')
  const [withTools, setTools] = useState(false)
  const tools = toolRows && withTools
  const [found, setFound] = useState<Found | null>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  const [step, setStep] = useState(0)
  const loadingMore = useRef(false)
  const q = normalizeSearchQuery(query)
  const key = searchKey(open, q, [path, mode, String(tools)])
  const shown = found !== null && found.key === key ? found : null

  useEffect(() => {
    if (key === null) {
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      apiGet<SearchResult>(searchUrl(path, { q, mode, tools }), controller.signal)
        .then((result) => {
          setFound({
            key,
            hits: result.hits,
            hasMore: result.has_more,
            index: result.hits.length > 0 ? 0 : -1,
            error: null,
          })
          setStep((value) => value + 1)
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) {
            setFound({ key, hits: [], hasMore: false, index: -1, error: errorText(e) })
          }
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, path, q, mode, tools])

  const moveTo = useCallback((index: number) => {
    setFound((prev) => prev && { ...prev, index })
    setStep((value) => value + 1)
  }, [])

  const older = useCallback(() => {
    if (shown === null || shown.hits.length === 0) {
      return
    }
    const last = shown.hits.at(-1)
    if (shown.index + 1 < shown.hits.length || !shown.hasMore || last === undefined) {
      moveTo((shown.index + 1) % shown.hits.length)
      return
    }
    if (loadingMore.current) {
      return
    }
    loadingMore.current = true
    apiGet<SearchResult>(searchUrl(path, { q, mode, tools, before: last.id }))
      .then((result) => {
        setFound((prev) =>
          prev?.key === shown.key
            ? {
                ...prev,
                hits: [...prev.hits, ...result.hits],
                hasMore: result.has_more,
                index: result.hits.length > 0 ? prev.index + 1 : 0,
              }
            : prev,
        )
        setStep((value) => value + 1)
      })
      .catch((e: unknown) => {
        setFound((prev) => (prev?.key === shown.key ? { ...prev, error: errorText(e) } : prev))
      })
      .finally(() => {
        loadingMore.current = false
      })
  }, [shown, path, q, mode, tools, moveTo])

  const newer = useCallback(() => {
    if (shown !== null && shown.hits.length > 0) {
      moveTo(shown.index > 0 ? shown.index - 1 : shown.hits.length - 1)
    }
  }, [shown, moveTo])

  const openFind = useCallback(() => {
    setOpen(true)
    setFocusRequest((value) => value + 1)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
  }, [])

  const hits = shown?.hits ?? []
  const index = shown?.index ?? -1
  return {
    open,
    query,
    mode,
    tools: toolRows ? tools : null,
    hits,
    hasMore: shown?.hasMore ?? false,
    index,
    current: hits[index] ?? null,
    searching: key !== null && shown === null,
    error: shown?.error ?? null,
    focusRequest,
    step,
    openFind,
    close,
    setQuery,
    setMode,
    setTools,
    older,
    newer,
  }
}

interface ChatView {
  path: string
  target: ChatSearchTarget
  /** The chat's element; Ctrl+F with focus inside it opens this chat's find first. */
  root: RefObject<HTMLElement | null>
  /** Shows the messages around a hit, fetching them when they are not loaded. */
  jumpTo: (id: number) => Promise<void>
  backToLatest: () => void
  /** How the Ctrl+K palette offers this chat's find. */
  command: Pick<PaletteCommand, 'id' | 'title' | 'detail' | 'group' | 'when'>
  /** The chat shows tool calls and output, which find leaves out until the user turns them on. */
  toolRows?: boolean
}

/** Find wired to a chat view: open on Ctrl+F, show each hit, close back to the newest messages. */
export function useChatFindIn({ path, target, root, jumpTo, backToLatest, command, toolRows = false }: ChatView) {
  const find = useChatFind(path, toolRows)
  const { openFind, close, current, step, open } = find

  const active = useCommandScope()
  const latest = useRef(find)
  useLayoutEffect(() => {
    latest.current = find
  })
  const closeFind = useCallback(() => {
    close()
    backToLatest()
  }, [close, backToLatest])
  useEffect(
    () =>
      active
        ? registerChatSearch({
            target,
            root: () => root.current,
            open: openFind,
            isOpen: () => latest.current.open,
            step: (direction) => {
              latest.current[direction]()
            },
            close: closeFind,
          })
        : undefined,
    [active, target, root, openFind, closeFind],
  )
  useCommands([
    {
      ...command,
      icon: TextSearch,
      keywords: 'find messages transcript text',
      shortcut: FIND_SHORTCUT,
      run: () => {
        openChatSearch(target)
      },
    },
  ])

  const show = useEffectEvent((id: number) => {
    jumpTo(id).catch((e: unknown) => toast.error(errorText(e)))
  })
  useEffect(() => {
    if (open && current !== null) {
      show(current.id)
    }
  }, [open, current, step])

  const marks: FindMarks | null = open
    ? { query: find.query, mode: find.mode, messagesOnly: find.tools === false, focusId: current?.id ?? null, step }
    : null
  return { find, closeFind, marks }
}
