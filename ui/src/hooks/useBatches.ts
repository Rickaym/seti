import { useEffect, useRef, useState } from 'react'

/** Grows the mounted row count by a batch each time the sentinel scrolls into view. */
export function useBatches(total: number, batch: number) {
  const [shown, setShown] = useState(batch)
  const sentinel = useRef<HTMLLIElement & HTMLDivElement>(null)
  useEffect(() => {
    const node = sentinel.current
    if (node === null || shown >= total) {
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShown((n) => n + batch)
      }
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [shown, total, batch])
  return { shown, sentinel }
}
