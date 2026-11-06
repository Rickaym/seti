import type { ResponseSchema } from '@seti/shared'
import { errorText, readResponse } from '@/api'
import { getIfChanged } from '@/lib/conditional-get'
import { startPolling } from '@/lib/poll-loop'
import { shareEqual } from '@/lib/share-equal'

export interface PolledState<T> {
  data: T | undefined
  error: string | null
  /** When the latest answer came, as of the last change to data or error. */
  lastOk: number | null
}

export interface PolledResource<T> {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => PolledState<T>
  refresh: () => void
}

function failure(e: unknown): string {
  return e instanceof DOMException && e.name === 'TimeoutError' ? 'No response' : errorText(e)
}

/** Refreshers of the resources someone subscribes to right now. */
const active = new Set<() => void>()

/** Refetches every polled resource in use now instead of waiting for its next poll. */
export function refreshAllPolled(): void {
  for (const refresh of active) {
    refresh()
  }
}

/** One poll of a GET endpoint for all subscribers; a 304 or a repeat notifies nobody. */
export function createPolledResource<T>(
  path: string,
  intervalMs: number,
  { schema }: { schema?: ResponseSchema<T> } = {},
): PolledResource<T> {
  let state: PolledState<T> = { data: undefined, error: null, lastOk: null }
  let issued = 0
  let applied = 0
  let latestOk: number | null = null
  let etag: string | null = null
  let stop: (() => void) | undefined
  const listeners = new Set<() => void>()

  const apply = (id: number, update: (prev: PolledState<T>) => PolledState<T>) => {
    if (id < applied) {
      return
    }
    applied = id
    const next = update(state)
    if (next === state) {
      return
    }
    state = next
    for (const listener of listeners) {
      listener()
    }
  }

  const answered = (id: number, data: T | undefined) => {
    latestOk = Date.now()
    apply(id, (prev) => {
      const shared = data === undefined ? prev.data : shareEqual(prev.data, data)
      return shared === prev.data && prev.error === null ? prev : { data: shared, error: null, lastOk: latestOk }
    })
  }

  const refresh = () => {
    issued += 1
    const id = issued
    getIfChanged(path, etag, AbortSignal.timeout(intervalMs))
      .then((answer) => {
        if (answer === null || id < applied) {
          answered(id, undefined)
          return
        }
        const data = schema === undefined ? (answer.data as T) : readResponse(path, schema, answer.data)
        etag = answer.etag
        answered(id, data)
      })
      .catch((e: unknown) => {
        const error = failure(e)
        apply(id, (prev) => (prev.error === error ? prev : { ...prev, error, lastOk: latestOk }))
      })
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    if (listeners.size === 1) {
      active.add(refresh)
      stop = startPolling(refresh, intervalMs, { leading: true })
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        active.delete(refresh)
        stop?.()
        stop = undefined
      }
    }
  }

  return { subscribe, getSnapshot: () => state, refresh }
}
