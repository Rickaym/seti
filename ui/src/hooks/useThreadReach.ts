import type { ThreadReach } from '@seti/shared'
import { useEffect, useState } from 'react'
import { apiGet } from '@/api'

/** Threads agents follow and webhooks reading their replies; null until known. */
export function useThreadReach(): ThreadReach | null {
  const [reach, setReach] = useState<ThreadReach | null>(null)
  useEffect(() => {
    let current = true
    apiGet<ThreadReach>('/channels/thread-reach').then(
      (found) => {
        if (current) {
          setReach(found)
        }
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [])
  return reach
}
