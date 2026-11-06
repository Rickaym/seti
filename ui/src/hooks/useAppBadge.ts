import { useEffect } from 'react'

/** Puts the number of agents that need you on the installed app's icon, where browsers allow it. */
export function useAppBadge(count: number) {
  useEffect(() => {
    if (!('setAppBadge' in navigator)) {
      return
    }
    const shown = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()
    // iOS refuses the badge until notifications are allowed; the status bar still shows the count.
    shown.catch(() => undefined)
  }, [count])
}
