import type { PluginListing } from '@seti/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, errorText } from '@/api'

/** Loads the plugin listing; a new refreshToken asks the server to re-read Claude Code's plugins. */
export function usePlugins(refreshToken: number) {
  const [listing, setListing] = useState<PluginListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [n, setN] = useState(0)
  const lastToken = useRef(refreshToken)

  useEffect(() => {
    let stale = false
    const refresh = lastToken.current !== refreshToken
    lastToken.current = refreshToken
    apiGet<PluginListing>(`/plugins${refresh ? '?refresh=1' : ''}`)
      .then((next) => {
        if (!stale) {
          setListing(next)
          setError('')
        }
      })
      .catch((e: unknown) => {
        if (!stale) {
          setError(errorText(e))
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [refreshToken, n])

  const reload = useCallback(() => {
    setLoading(true)
    setN((value) => value + 1)
  }, [])

  return { listing, loading, error, reload }
}
