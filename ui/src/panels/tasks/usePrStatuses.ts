import { pullRequestsSchema, type PullRequest } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { apiPost, readResponse } from '@/api'

const NONE: ReadonlyMap<string, PullRequest> = new Map()

/** Live status of the open PRs among the URLs, in one request for the whole set. */
export function usePrStatuses(urls: readonly string[]): {
  statuses: ReadonlyMap<string, PullRequest>
  reload: () => void
} {
  const [statuses, setStatuses] = useState(NONE)
  const [round, setRound] = useState(0)
  const key = urls.toSorted((a, b) => a.localeCompare(b)).join('\n')

  useEffect(() => {
    if (key === '') {
      return
    }
    let live = true
    apiPost<unknown>('/prs/lookup', { urls: key.split('\n') })
      .then((body) => {
        if (live) {
          setStatuses(new Map(readResponse('/prs/lookup', pullRequestsSchema, body).map((pr) => [pr.url, pr])))
        }
      })
      // A failed lookup keeps the last statuses; the chips still link and unlink without them.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key, round])

  const reload = useCallback(() => {
    setRound((n) => n + 1)
  }, [])
  return { statuses: key === '' ? NONE : statuses, reload }
}
