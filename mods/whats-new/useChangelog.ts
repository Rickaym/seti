import type { Changelog, SetiUpdate } from '@seti/mod-api'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { errorText, useWhatsNew } from './mod-context'

const UNANSWERED: SetiUpdate = {
  state: 'unknown',
  branch: 'main',
  latest: null,
  behind: null,
  notable: null,
  checked_at: null,
  error: null,
  command: '',
}

/** A fresh update check on mount, showing the last polled one until it answers. */
export function useSetiUpdate(): SetiUpdate | null {
  const { api, status } = useWhatsNew()
  const polled = useSyncExternalStore(status.subscribe, status.getSnapshot).data?.update ?? null
  const [fresh, setFresh] = useState<SetiUpdate | null>(null)
  useEffect(() => {
    let live = true
    api
      .request<SetiUpdate>('GET', '/update')
      .then((update) => {
        if (live) {
          setFresh(update)
          status.refresh()
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setFresh({ ...UNANSWERED, error: errorText(e) })
        }
      })
    return () => {
      live = false
    }
  }, [api, status])
  return fresh ?? polled
}

/** The newest `limit` changelog entries, and why they could not be read. */
export function useChangelog(limit: number): { log: Changelog | null; error: string } {
  const { api } = useWhatsNew()
  const [log, setLog] = useState<Changelog | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api
      .request<Changelog>('GET', `/changelog?limit=${String(limit)}`)
      .then((data) => {
        if (live) {
          setLog(data)
          setError('')
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setError(errorText(e))
        }
      })
    return () => {
      live = false
    }
  }, [api, limit])
  return { log, error }
}
