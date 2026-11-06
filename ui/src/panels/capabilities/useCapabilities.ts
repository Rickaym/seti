import type { CapabilitiesSnapshot } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost, errorText } from '@/api'

export const USER_SCOPE = 'user'

interface Request {
  scope: string
  refresh: boolean
  n: number
}

async function fetchSnapshot({ scope, refresh }: Request): Promise<CapabilitiesSnapshot> {
  const body = scope === USER_SCOPE ? {} : { repo_id: scope }
  if (refresh) {
    return apiPost<CapabilitiesSnapshot>('/capabilities/refresh', body)
  }
  const search = scope === USER_SCOPE ? '' : `?${new URLSearchParams(body).toString()}`
  return apiGet<CapabilitiesSnapshot>(`/capabilities${search}`)
}

export function useCapabilities() {
  const [request, setRequest] = useState<Request>({ scope: USER_SCOPE, refresh: false, n: 0 })
  const [snapshot, setSnapshot] = useState<CapabilitiesSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let stale = false
    fetchSnapshot(request)
      .then((next) => {
        if (!stale) {
          setSnapshot(next)
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
  }, [request])

  const selectScope = useCallback((scope: string) => {
    setLoading(true)
    setSnapshot(null)
    setRequest((r) => ({ scope, refresh: false, n: r.n + 1 }))
  }, [])

  const refresh = useCallback(() => {
    setLoading(true)
    setRequest((r) => ({ scope: r.scope, refresh: true, n: r.n + 1 }))
  }, [])

  const reload = useCallback(() => {
    setLoading(true)
    setRequest((r) => ({ scope: r.scope, refresh: false, n: r.n + 1 }))
  }, [])

  return { scope: request.scope, snapshot, loading, error, selectScope, refresh, reload }
}
