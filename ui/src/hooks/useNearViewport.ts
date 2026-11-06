import { useEffect, useState, type RefObject } from 'react'

/** How far off screen an element counts as near, so it is ready by the time it scrolls in. */
const MARGIN = '400px 0px'

const pending = new Map<Element, () => void>()
let observer: IntersectionObserver | null = null

/** One observer for every watched element, since a long transcript holds many. */
function sharedObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const arrive = pending.get(entry.target)
        if (entry.isIntersecting && arrive !== undefined) {
          pending.delete(entry.target)
          observer?.unobserve(entry.target)
          arrive()
        }
      }
    },
    { rootMargin: MARGIN },
  )
  return observer
}

/** Turns true once the element comes near the screen and then stays true; false while disabled. */
export function useNearViewport(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const element = ref.current
    if (!enabled || near || element === null) {
      return undefined
    }
    const watcher = sharedObserver()
    pending.set(element, () => {
      setNear(true)
    })
    watcher.observe(element)
    return () => {
      pending.delete(element)
      watcher.unobserve(element)
    }
  }, [ref, enabled, near])
  return near
}
