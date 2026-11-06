import type { SshStatus } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { navigate } from '@/lib/route'

/** Hosts and keys from the server, replaced whole after each change. */
export interface SshState {
  status: SshStatus | null
  error: string
  setStatus: (next: SshStatus) => void
  reload: () => void
}

/** Loads the ssh status, again whenever `key` changes, as when another host opens. */
export function useSshStatus(key: string | null): SshState {
  const [status, setStatus] = useState<SshStatus | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    apiGet<SshStatus>('/ssh').then(
      (next) => {
        setStatus(next)
        setError('')
      },
      (e: unknown) => {
        setError(errorText(e))
      },
    )
  }, [])
  useEffect(reload, [reload, key])
  return { status, error, setStatus, reload }
}

/** Hosts just added with a key, whose page checks them once when it opens. */
const checkOnOpen = new Set<string>()

export const checkWhenOpened = (alias: string) => {
  checkOnOpen.add(alias)
}

/** True once after `checkWhenOpened`, so the page checks the host a single time. */
export const takeCheckRequest = (alias: string) => checkOnOpen.delete(alias)

/** The prefix of a key's detail on the SSH page; host aliases never hold a slash. */
export const KEY_ROUTE = 'keys/'

export const openKey = (id: string) => {
  navigate('settings', `ssh/${KEY_ROUTE}${id}`, { force: true })
}

export const openHost = (alias: string) => {
  navigate('settings', `ssh/${alias}`, { force: true })
}
