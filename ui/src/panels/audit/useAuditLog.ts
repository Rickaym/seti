import type { AuditActorFilter, AuditArea, AuditEvent, AuditPage } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'

const PAGE_SIZE = 100

export interface AuditFilter {
  area: AuditArea | null
  actor: AuditActorFilter | null
  q: string
}

interface LogState {
  query: string
  events: AuditEvent[]
  nextBefore: number | null
  error: string
}

function queryOf(filter: AuditFilter): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (filter.area !== null) {
    params.set('kind', filter.area)
  }
  if (filter.actor !== null) {
    params.set('actor', filter.actor)
  }
  if (filter.q.trim() !== '') {
    params.set('q', filter.q.trim())
  }
  return params.toString()
}

/** Prepends events newer than the top one; replaces the list when the new page leaves a gap. */
function mergeNewest(prev: LogState, page: AuditPage): LogState {
  const top = prev.events[0]?.id ?? 0
  const fresh = page.events.filter((event) => event.id > top)
  if (fresh.length === page.events.length && page.next_before !== null) {
    return { ...prev, events: page.events, nextBefore: page.next_before, error: '' }
  }
  return { ...prev, events: [...fresh, ...prev.events], error: '' }
}

/** Newest-first audit events for a filter, with cursor paging and an incremental refresh. */
export function useAuditLog(filter: AuditFilter) {
  const query = queryOf(filter)
  const [state, setState] = useState<LogState | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)

  useEffect(() => {
    let current = true
    apiGet<AuditPage>(`/audit?${query}`)
      .then((page) => {
        if (current) {
          setState({ query, events: page.events, nextBefore: page.next_before, error: '' })
        }
      })
      .catch((e: unknown) => {
        if (current) {
          setState({ query, events: [], nextBefore: null, error: errorText(e) })
        }
      })
    return () => {
      current = false
    }
  }, [query])

  const refresh = useCallback(() => {
    apiGet<AuditPage>(`/audit?${query}`)
      .then((page) => {
        setState((prev) => (prev?.query === query ? mergeNewest(prev, page) : prev))
      })
      .catch((e: unknown) => {
        setState((prev) => (prev?.query === query ? { ...prev, error: errorText(e) } : prev))
      })
  }, [query])

  const current = state?.query === query ? state : null
  const nextBefore = current?.nextBefore ?? null

  const loadOlder = useCallback(() => {
    if (nextBefore === null) {
      return
    }
    setLoadingOlder(true)
    apiGet<AuditPage>(`/audit?${query}&before=${String(nextBefore)}`)
      .then((page) => {
        setState((prev) =>
          prev?.query === query
            ? { ...prev, events: [...prev.events, ...page.events], nextBefore: page.next_before }
            : prev,
        )
      })
      .catch((e: unknown) => toast.error(errorText(e)))
      .finally(() => {
        setLoadingOlder(false)
      })
  }, [query, nextBefore])

  return {
    events: current?.events ?? [],
    error: current?.error ?? '',
    loading: current === null,
    hasOlder: nextBefore !== null,
    loadingOlder,
    refresh,
    loadOlder,
  }
}
