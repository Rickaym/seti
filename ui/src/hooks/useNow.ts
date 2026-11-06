import { useEffect, useState } from 'react'

/** The current time, ticking every `everyMs` while `live`; a still value otherwise. */
export function useNow(live: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live) {
      return undefined
    }
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, everyMs)
    return () => {
      window.clearInterval(timer)
    }
  }, [live, everyMs])
  return now
}
