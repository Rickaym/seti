import { useEffect, useState, useSyncExternalStore } from 'react'

const MINUTE = 60_000
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/** The current time, refreshed at the start of every minute. */
export function useMinute(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          setNow(Date.now())
          schedule()
        },
        MINUTE - (Date.now() % MINUTE),
      )
    }
    schedule()
    return () => {
      window.clearTimeout(timer)
    }
  }, [])
  return now
}

function subscribeMotion(onChange: () => void): () => void {
  const media = window.matchMedia(REDUCED_MOTION)
  media.addEventListener('change', onChange)
  return () => {
    media.removeEventListener('change', onChange)
  }
}

/** True when the device asks for less motion, so the weather holds still. */
export const usePrefersReducedMotion = (): boolean =>
  useSyncExternalStore(subscribeMotion, () => window.matchMedia(REDUCED_MOTION).matches)
