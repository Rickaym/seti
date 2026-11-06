import { pingApi } from '@/api'
import { createLatencyProbe } from '@/lib/latency'
import { createLink, type LinkEnv, type LinkHints } from '@/lib/link'

const PING_TIMEOUT_MS = 5000

interface NetworkInformation extends EventTarget {
  saveData?: boolean
  effectiveType?: string
}

const isOnline = () => typeof navigator === 'undefined' || !('onLine' in navigator) || navigator.onLine

function networkInformation(): NetworkInformation | null {
  if (typeof navigator === 'undefined' || !('connection' in navigator)) {
    return null
  }
  const connection: unknown = navigator.connection
  return connection instanceof EventTarget ? connection : null
}

const browserEnv: LinkEnv = {
  online: isOnline,
  hints: (): LinkHints => {
    const connection = networkInformation()
    return { saveData: connection?.saveData === true, effectiveType: connection?.effectiveType ?? null }
  },
  listen: (onChange) => {
    if (typeof window === 'undefined') {
      return () => undefined
    }
    const connection = networkInformation()
    window.addEventListener('online', onChange)
    window.addEventListener('offline', onChange)
    connection?.addEventListener('change', onChange)
    return () => {
      window.removeEventListener('online', onChange)
      window.removeEventListener('offline', onChange)
      connection?.removeEventListener('change', onChange)
    }
  },
}

export const latencyProbe = createLatencyProbe(
  async () => pingApi(AbortSignal.timeout(PING_TIMEOUT_MS)),
  () => document.visibilityState === 'visible' && isOnline(),
)

/** Whether this browser is online and how good its link to the server is. */
export const appLink = createLink(latencyProbe, browserEnv)
