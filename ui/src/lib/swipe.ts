interface Point {
  x: number
  y: number
}

interface TouchLike {
  touches: ArrayLike<{ clientX: number; clientY: number }>
  changedTouches: ArrayLike<{ clientX: number; clientY: number }>
  target: EventTarget | null
  timeStamp: number
}

type Direction = 'left' | 'right'

const MIN_DISTANCE = 64
const MAX_DURATION_MS = 700

/** The direction of a quick, mostly sideways swipe from start to end, or null for any other move. */
export function swipeDirection(start: Point, end: Point, durationMs: number): Direction | null {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (durationMs > MAX_DURATION_MS || Math.abs(dx) < MIN_DISTANCE || Math.abs(dy) * 2 > Math.abs(dx)) {
    return null
  }
  return dx > 0 ? 'right' : 'left'
}

const OWN_GESTURES = 'input, textarea, select, [contenteditable="true"], .xterm, [data-no-swipe]'

function scrolledSideways(element: Element): boolean {
  if (element.scrollLeft <= 0 || element.scrollWidth <= element.clientWidth) {
    return false
  }
  const overflow = getComputedStyle(element).overflowX
  return overflow === 'auto' || overflow === 'scroll'
}

/** True when a swipe right belongs to its target: a field, the terminal or a scrolled box. */
export function ownsSwipeRight(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  if (target.closest(OWN_GESTURES) !== null) {
    return true
  }
  for (let node: Element | null = target; node !== null; node = node.parentElement) {
    if (scrolledSideways(node)) {
      return true
    }
  }
  return false
}

/** Touch handlers that call onSwipe after a one-finger swipe in the direction given. */
export function swipeTracker(direction: Direction, onSwipe: () => void, ignore: (event: TouchLike) => boolean) {
  let start: (Point & { at: number }) | null = null
  return {
    start: (event: TouchLike) => {
      const touch = event.touches[0]
      start =
        event.touches.length === 1 && touch !== undefined && !ignore(event)
          ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp }
          : null
    },
    end: (event: TouchLike) => {
      const touch = event.changedTouches[0]
      const from = start
      start = null
      if (from === null || touch === undefined) {
        return
      }
      const end = { x: touch.clientX, y: touch.clientY }
      if (swipeDirection(from, end, event.timeStamp - from.at) === direction) {
        onSwipe()
      }
    },
    cancel: () => {
      start = null
    },
  }
}
