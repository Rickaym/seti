import { RefreshCw, WifiOff, type LucideIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useLink } from '@/hooks/useLatency'
import { useSystem } from '@/hooks/useSystem'
import { appReach } from '@/lib/reach'

export type Connection = 'pending' | 'up' | 'reconnecting' | 'down' | 'offline'

interface Signs {
  online: boolean
  /** Polls go unanswered, whichever view sent them. */
  reconnecting: boolean
  /** What the server answered wrong to /api/system, or that it never answered. */
  error: string | null
  lastOk: number | null
}

/** One state for the whole app: a lost link outranks the server's own errors. */
export function connectionOf({ online, reconnecting, error, lastOk }: Signs): Connection {
  if (!online) {
    return 'offline'
  }
  if (reconnecting) {
    return 'reconnecting'
  }
  if (error !== null) {
    return 'down'
  }
  return lastOk === null ? 'pending' : 'up'
}

/** The states the bar names in words, since data on screen may be behind; the rest need none. */
export const WAITING: Partial<Record<Connection, { text: string; icon: LucideIcon }>> = {
  reconnecting: { text: 'Reconnecting', icon: RefreshCw },
  offline: { text: 'Offline', icon: WifiOff },
}

/** How this browser reaches Seti's server, with when it last answered. */
export function useConnection(): { state: Connection; error: string | null; lastAnswer: number | null } {
  const { error, lastOk } = useSystem()
  const { online } = useLink()
  const reach = useSyncExternalStore(appReach.subscribe, appReach.getSnapshot)
  const state = connectionOf({ online, reconnecting: reach.reconnecting, error, lastOk })
  return { state, error, lastAnswer: state === 'reconnecting' ? reach.lastAnswer : lastOk }
}
