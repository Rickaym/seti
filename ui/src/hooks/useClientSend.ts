import { useCallback, useRef, useState } from 'react'
import { appLink } from '@/lib/app-link'
import { linkConnectivity, type RetryOptions } from '@/lib/send-retry'

const connectivity = linkConnectivity(appLink)

/** Shown while a send retries; quiet, since it may still go through. */
export const RETRYING_LABEL = 'Sending... retrying'

export interface ClientSend {
  /** True while the current send waits to retry or retries. */
  retrying: boolean
  /**
   * Sends `content` with its client id: the same id while the content is unchanged and not yet
   * sent, so a manual resend after a failure is still taken once; a new one after success.
   */
  run: <T>(content: string, send: (clientId: string, options: RetryOptions) => Promise<T>) => Promise<T>
}

/** One client id per piece of content until it goes through, and whether it is retrying. */
export function useClientSend(): ClientSend {
  const pending = useRef<{ content: string; id: string } | null>(null)
  const [retrying, setRetrying] = useState(false)
  const run = useCallback(
    async <T>(content: string, send: (clientId: string, options: RetryOptions) => Promise<T>): Promise<T> => {
      if (pending.current?.content !== content) {
        pending.current = { content, id: crypto.randomUUID() }
      }
      const current = pending.current
      try {
        const result = await send(current.id, {
          connectivity,
          onRetrying: () => {
            setRetrying(true)
          },
        })
        if (pending.current === current) {
          pending.current = null
        }
        return result
      } finally {
        setRetrying(false)
      }
    },
    [],
  )
  return { retrying, run }
}
