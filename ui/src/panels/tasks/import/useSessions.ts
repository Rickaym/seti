import type { ClaudeSession, ClaudeSessionDetail, ClaudeSessionPage } from '@seti/shared'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'

const PAGE_SIZE = 50
const SEARCH_DELAY_MS = 250

const pagePath = (query: string, offset: number) => {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
  if (query.trim() !== '') {
    params.set('q', query.trim())
  }
  return `/sessions?${params.toString()}`
}

interface Loaded {
  query: string
  rows: ClaudeSession[]
  total: number
}

/** Sessions matching a search, fetched after a short pause in typing, with paging. */
export function useSessionSearch(query: string) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(
      () => {
        apiGet<ClaudeSessionPage>(pagePath(query, 0), controller.signal)
          .then((page) => {
            setLoaded({ query, rows: page.sessions, total: page.total })
          })
          .catch((e: unknown) => {
            if (!controller.signal.aborted) {
              toast.error(errorText(e))
            }
          })
      },
      query === '' ? 0 : SEARCH_DELAY_MS,
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const loadMore = async () => {
    if (loaded === null) {
      return
    }
    setLoadingMore(true)
    try {
      const page = await apiGet<ClaudeSessionPage>(pagePath(loaded.query, loaded.rows.length))
      setLoaded((prev) =>
        prev?.query === loaded.query ? { ...prev, rows: [...prev.rows, ...page.sessions], total: page.total } : prev,
      )
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setLoadingMore(false)
    }
  }

  return {
    rows: loaded?.rows ?? null,
    total: loaded?.total ?? 0,
    searching: loaded?.query !== query,
    loadingMore,
    loadMore,
  }
}

/** Details of the given sessions, each fetched once. */
export function useSessionDetails(ids: readonly string[]): Record<string, ClaudeSessionDetail> {
  const [details, setDetails] = useState<Record<string, ClaudeSessionDetail>>({})
  const requested = useRef(new Set<string>())
  const key = ids.join(',')

  useEffect(() => {
    for (const id of key.split(',')) {
      if (id === '' || requested.current.has(id)) {
        continue
      }
      requested.current.add(id)
      apiGet<ClaudeSessionDetail>(`/sessions/${id}`)
        .then((detail) => {
          setDetails((prev) => ({ ...prev, [id]: detail }))
        })
        .catch((e: unknown) => {
          requested.current.delete(id)
          toast.error(errorText(e))
        })
    }
  }, [key])

  return details
}
