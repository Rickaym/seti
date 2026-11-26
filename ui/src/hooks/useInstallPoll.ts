import { useEffect } from 'react'
import { refreshRuntimes } from '@/hooks/useRuntimes'

/** How often a card asks again while its runtime installs, so Ready shows soon after it lands. */
const INSTALL_POLL_MS = 2000

/** Asks for the state again every few seconds while the runtime installs. */
export function useInstallPoll(installing: boolean): void {
  useEffect(() => {
    if (!installing) {
      return undefined
    }
    const timer = setInterval(refreshRuntimes, INSTALL_POLL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [installing])
}
