import type { ResolvedPath } from '@seti/shared'
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { FileTarget } from '@/panels/files/files-api'
import type { PathResolver } from '@/panels/files/path-resolver'

/** How the transcript turns paths into links: which exist, and how to open one in Files. */
export interface FileLinks {
  /** The task whose roots a found path without a task_id is in; null where there is none. */
  taskId: string | null
  resolver: PathResolver
  open: (target: FileTarget) => void
}

export const FileLinksContext = createContext<FileLinks | null>(null)

export const useFileLinks = () => useContext(FileLinksContext)

const noSubscribe = () => () => undefined

/** A missing file may be written later, so a shown miss is asked again, less often over time. */
const RECHECK_FIRST_MS = 21_000
const RECHECK_MAX_MS = 5 * 60_000

/** Where a mentioned path lives, once the server said it exists; null otherwise. */
export function useResolvedPath(path: string): ResolvedPath | null {
  const links = useFileLinks()
  const resolver = links?.resolver ?? null
  useEffect(() => {
    resolver?.request(path)
  }, [resolver, path])
  const found = useSyncExternalStore(resolver?.subscribe ?? noSubscribe, () => resolver?.peek(path))
  const missing = found === null
  useEffect(() => {
    if (resolver === null || !missing) {
      return
    }
    let delay = RECHECK_FIRST_MS
    let timer = 0
    const again = () => {
      if (document.visibilityState === 'visible') {
        resolver.request(path)
      }
      delay = Math.min(delay * 2, RECHECK_MAX_MS)
      timer = window.setTimeout(again, delay)
    }
    timer = window.setTimeout(again, delay)
    return () => {
      window.clearTimeout(timer)
    }
  }, [resolver, path, missing])
  return found ?? null
}
