import { FILE_RESOLVE_MAX, type ResolvedPath } from '@seti/shared'
import { apiGet } from '@/api'

/** A path that was not there may appear once the agent writes it, so misses are asked again. */
const MISS_TTL_MS = 20_000
const BATCH_MS = 40

interface Known {
  value: ResolvedPath | null
  at: number
}

/** Checks which mentioned paths exist, in batches, remembering the answers. */
export interface PathResolver {
  /** The answer so far: a path, null when there is no such file, undefined until asked. */
  peek: (path: string) => ResolvedPath | null | undefined
  /** Asks the server about the path unless a fresh answer is known or on its way. */
  request: (path: string) => void
  subscribe: (listener: () => void) => () => void
}

/** Resolves in a task's roots and any task's workspace; without a task, in workspaces only. */
export function createPathResolver(taskId: string | null): PathResolver {
  const base = taskId === null ? '/files/resolve' : `/tasks/${taskId}/files/resolve`
  const known = new Map<string, Known>()
  const queued = new Set<string>()
  const asking = new Set<string>()
  const listeners = new Set<() => void>()
  let timer: number | undefined

  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }

  const ask = async (paths: readonly string[]) => {
    const query = paths.map((path) => `p=${encodeURIComponent(path)}`).join('&')
    try {
      const found = await apiGet<(ResolvedPath | null)[]>(`${base}?${query}`)
      const at = Date.now()
      paths.forEach((path, index) => known.set(path, { value: found[index] ?? null, at }))
    } catch {
      paths.forEach((path) => known.set(path, { value: null, at: Date.now() }))
    } finally {
      paths.forEach((path) => asking.delete(path))
      notify()
    }
  }

  const flush = () => {
    timer = undefined
    const paths = [...queued]
    queued.clear()
    for (let start = 0; start < paths.length; start += FILE_RESOLVE_MAX) {
      void ask(paths.slice(start, start + FILE_RESOLVE_MAX))
    }
  }

  const fresh = (entry: Known | undefined) =>
    entry !== undefined && (entry.value !== null || Date.now() - entry.at < MISS_TTL_MS)

  return {
    peek: (path) => known.get(path)?.value,
    request: (path) => {
      if (fresh(known.get(path)) || asking.has(path) || queued.has(path)) {
        return
      }
      queued.add(path)
      asking.add(path)
      timer ??= window.setTimeout(flush, BATCH_MS)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
