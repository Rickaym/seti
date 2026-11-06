import { pinchFont, terminalFont } from './terminal-font'

const spread = (touches: TouchList) => {
  const [a, b] = [touches[0], touches[1]]
  return a === undefined || b === undefined ? 0 : Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/**
 * Two fingers spreading or pinching on the terminal grow or shrink its font, in place of the
 * page zoom a browser would do. Returns the teardown.
 */
export function pinchToZoom(host: HTMLElement): () => void {
  let start: { spread: number; size: number } | null = null
  const onStart = (event: TouchEvent) => {
    start = event.touches.length === 2 ? { spread: spread(event.touches), size: terminalFont.get() } : null
  }
  const onMove = (event: TouchEvent) => {
    if (start === null || event.touches.length !== 2 || start.spread === 0) {
      return
    }
    event.preventDefault()
    terminalFont.set(pinchFont(start.size, spread(event.touches) / start.spread))
  }
  const onEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) {
      start = null
    }
  }
  host.addEventListener('touchstart', onStart, { passive: true })
  host.addEventListener('touchmove', onMove, { passive: false })
  host.addEventListener('touchend', onEnd)
  host.addEventListener('touchcancel', onEnd)
  return () => {
    host.removeEventListener('touchstart', onStart)
    host.removeEventListener('touchmove', onMove)
    host.removeEventListener('touchend', onEnd)
    host.removeEventListener('touchcancel', onEnd)
  }
}
