import { useEffect, useState } from 'react'

const MINUTE = 60_000

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
