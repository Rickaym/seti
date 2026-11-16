import type { PullRequest } from '@seti/shared'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  prStatus,
  prStatusVersion,
  reloadPrStatuses,
  subscribePrStatuses,
  watchPrStatuses,
} from '@/panels/tasks/pr-status-store'

const NO_URLS: readonly string[] = []

export interface PrStatuses {
  /** The open PRs among the URLs whose status has arrived. */
  statuses: ReadonlyMap<string, PullRequest>
  /** URLs asked for and not answered yet; the rest without a status are no open PR. */
  loading: ReadonlySet<string>
  reload: () => void
}

/**
 * Live status of the open PRs among the URLs, shared by every view that shows them: one request
 * for all, asked again until GitHub answered and every minute while the page is on screen.
 */
export function usePrStatuses(urls: readonly string[]): PrStatuses {
  const key = urls.toSorted((a, b) => a.localeCompare(b)).join('\n')
  const version = useSyncExternalStore(subscribePrStatuses, prStatusVersion)

  useEffect(() => (key === '' ? undefined : watchPrStatuses(key.split('\n'))), [key])

  const { statuses, loading } = useMemo(() => {
    const ready = new Map<string, PullRequest>()
    const waiting = new Set<string>()
    for (const url of key === '' ? NO_URLS : key.split('\n')) {
      const status = prStatus(url)
      if (status.state === 'ready') {
        ready.set(url, status.pr)
      } else if (status.state === 'loading') {
        waiting.add(url)
      }
    }
    return { statuses: ready, loading: waiting }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the store's version says when to read it again
  }, [key, version])

  const reload = useCallback(() => {
    reloadPrStatuses(key === '' ? NO_URLS : key.split('\n'))
  }, [key])
  return { statuses, loading, reload }
}
