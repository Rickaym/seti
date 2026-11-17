import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText, isUnreachable } from '@/api'
import { getIfChanged } from '@/lib/conditional-get'
import { pollTimeoutMs, startPolling } from '@/lib/poll-loop'
import { appReach } from '@/lib/reach'
import { shareEqual } from '@/lib/share-equal'

interface Polled<T> {
  data: T | undefined
  error: string | null
  refresh: () => void
}

/** GETs `path` every `intervalMs` while it is set, online and visible; null stops polling. */
export function usePolledGet<T>(path: string | null, intervalMs: number): Polled<T> {
  const [state, setState] = useState<{ path: string | null; data: T | undefined; error: string | null }>({
    path,
    data: undefined,
    error: null,
  })
  const issued = useRef(0)
  const held = useRef<{ path: string; etag: string | null; data: T } | null>(null)

  const refresh = useCallback(() => {
    if (path === null) {
      return
    }
    issued.current += 1
    const id = issued.current
    const kept = held.current?.path === path ? held.current : null
    const sentAt = Date.now()
    getIfChanged(path, kept?.etag ?? null, AbortSignal.timeout(pollTimeoutMs(intervalMs)))
      .then((answer) => {
        appReach.answered()
        if (id !== issued.current) {
          return
        }
        const data = answer === null ? kept?.data : (answer.data as T)
        if (answer !== null) {
          held.current = { path, etag: answer.etag, data: answer.data as T }
        }
        setState((prev) => {
          const shared = shareEqual(prev.data, data)
          return prev.path === path && shared === prev.data && prev.error === null
            ? prev
            : { path, data: shared, error: null }
        })
      })
      .catch((e: unknown) => {
        const lost = isUnreachable(e)
        if (lost) {
          appReach.unanswered(sentAt)
        } else {
          appReach.answered()
        }
        if (id === issued.current) {
          const error = errorText(e)
          setState((prev) => {
            const shown = prev.path === path
            const keep = shown && (prev.error === error || (lost && prev.data !== undefined))
            return keep ? prev : { path, data: shown ? prev.data : undefined, error }
          })
        }
      })
  }, [path, intervalMs])

  useEffect(() => {
    if (path === null) {
      return undefined
    }
    const stop = startPolling(refresh, intervalMs, { leading: true })
    return () => {
      stop()
      issued.current += 1
    }
  }, [path, intervalMs, refresh])

  const current = state.path === path
  return { data: current ? state.data : undefined, error: current ? state.error : null, refresh }
}
