import { useLayoutEffect, useRef, useState } from 'react'
import { createDelayedShow } from '@/lib/delayed-show'

/** Shows an indicator once `active` lasts `delayMs`, then keeps it for at least `minShownMs`. */
function useDelayedShow(active: boolean, delayMs = 150, minShownMs = 250): boolean {
  const [shown, setShown] = useState(false)
  const control = useRef<ReturnType<typeof createDelayedShow> | null>(null)

  useLayoutEffect(() => {
    const created = createDelayedShow({ delayMs, minShownMs }, setShown)
    control.current = created
    return () => {
      created.dispose()
      control.current = null
      setShown(false)
    }
  }, [delayMs, minShownMs])

  // Runs in the commit that ends loading, so the show timer cannot fire once the content painted.
  useLayoutEffect(() => {
    control.current?.set(active)
  }, [active, delayMs, minShownMs])

  // After the effect above, so a show that loading already ended never counts as on screen.
  useLayoutEffect(() => {
    if (shown) {
      control.current?.displayed()
    }
  }, [shown])

  return shown
}

/** Loads still going after this long are on a slow network, and say so. */
const SLOW_MS = 8000

/** Whether a load shows its skeleton yet, and whether it has gone on long enough to call slow. */
export function useLoadingPlaceholder(loading: boolean): { skeleton: boolean; slow: boolean } {
  const skeleton = useDelayedShow(loading)
  const slow = useDelayedShow(loading, SLOW_MS, 0)
  return { skeleton, slow }
}
