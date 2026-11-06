import type { CredentialsOverview } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'

/** Every credential with what it carries, loaded again when `key` changes. */
export function useCredentials(key: string | null) {
  const [overview, setOverview] = useState<CredentialsOverview | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    apiGet<CredentialsOverview>('/credentials').then(
      (next) => {
        setOverview(next)
        setError('')
      },
      (e: unknown) => {
        setError(errorText(e))
      },
    )
  }, [])
  useEffect(reload, [reload, key])
  return { overview, error, reload }
}
