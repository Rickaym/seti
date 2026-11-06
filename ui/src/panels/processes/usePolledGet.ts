import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '@/api'
import { getIfChanged } from '@/lib/conditional-get'
import { startPolling } from '@/lib/poll-loop'
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
    getIfChanged(path, kept?.etag ?? null, AbortSignal.timeout(Math.max(intervalMs, 5000)))
      .then((answer) => {
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
        if (id === issued.current) {
          const error = errorText(e)
          setState((prev) => (prev.path === path && prev.error === error ? prev : { ...prev, path, error }))
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
