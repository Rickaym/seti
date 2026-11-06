import type { Terminal } from '@xterm/xterm'

/** A finger must travel this far before a touch scrolls instead of tapping. */
const SLOP_PX = 8
/** Velocity keeps this share of itself per 16 ms frame of a fling. */
const FRICTION = 0.95
/** A fling stops once slower than this, in px per ms. */
const STOP_SPEED = 0.03
/** A lift slower than this does not fling at all. */
const FLING_SPEED = 0.2
/** Weight of the newest move in the drag's velocity. */
const SMOOTHING = 0.6
/** A pause longer than this before lifting means the finger stopped, so no fling. */
const STALE_MS = 80
const FRAME_MS = 16

/** The drag's velocity after a move of `dy` px over `dt` ms, smoothed with the one before. */
export function nextVelocity(velocity: number, dy: number, dt: number): number {
  if (dt <= 0) {
    return velocity
  }
  return SMOOTHING * (dy / dt) + (1 - SMOOTHING) * velocity
}

/** One fling frame of `dt` ms: how far it scrolls and the velocity left, or null once it stops. */
export function flingStep(velocity: number, dt: number): { delta: number; velocity: number } | null {
  const next = velocity * FRICTION ** (dt / FRAME_MS)
  if (Math.abs(next) < STOP_SPEED) {
    return null
  }
  return { delta: next * dt, velocity: next }
}

/** Whether a lift at `velocity`, `idle` ms after the last move, flings. */
export const flings = (velocity: number, idle: number) => idle <= STALE_MS && Math.abs(velocity) >= FLING_SPEED

/**
 * Scrolls the terminal with one finger as a phone app scrolls, flinging on after a quick lift.
 * xterm 6 has no touch scrolling. The scrollback moves by whole lines; a full-screen program
 * gets the drag as wheel events, which xterm turns into arrow keys or mouse wheel reports as
 * it does for a real wheel. A drag never focuses the terminal; a tap still does. Returns the
 * teardown.
 */
export function scrollByTouch(term: Terminal, host: HTMLElement): () => void {
  let start: { x: number; y: number } | null = null
  let last = { y: 0, at: 0 }
  let dragging = false
  let velocity = 0
  let frame = 0
  let point = { x: 0, y: 0 }

  let pending = 0
  const program = () => term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none'
  /** One wheel event per line, as xterm sends a program one arrow or report per event. */
  const wheelLines = (screen: Element, lines: number) => {
    // Line mode, since xterm scales small pixel deltas down as if they came from a trackpad.
    const deltaY = Math.sign(lines)
    for (let line = 0; line < Math.abs(lines); line++) {
      screen.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: point.x,
          clientY: point.y,
          bubbles: true,
          cancelable: true,
        }),
      )
    }
  }
  const scroll = (deltaY: number) => {
    const screen = term.element?.querySelector('.xterm-screen')
    if (screen === null || screen === undefined || term.rows === 0) {
      return
    }
    const cell = screen.clientHeight / term.rows
    pending += deltaY
    const lines = Math.trunc(pending / cell)
    if (lines === 0) {
      return
    }
    pending -= lines * cell
    if (program()) {
      wheelLines(screen, lines)
    } else {
      term.scrollLines(lines)
    }
  }
  const stopFling = () => {
    cancelAnimationFrame(frame)
    frame = 0
  }
  const fling = () => {
    let at = performance.now()
    const step = (now: number) => {
      const next = flingStep(velocity, now - at)
      at = now
      if (next === null) {
        frame = 0
        return
      }
      velocity = next.velocity
      scroll(next.delta)
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  }

  const onStart = (event: TouchEvent) => {
    stopFling()
    const touch = event.touches.length === 1 ? event.touches[0] : undefined
    start = touch === undefined ? null : { x: touch.clientX, y: touch.clientY }
    dragging = false
    velocity = 0
    pending = 0
    if (touch !== undefined) {
      last = { y: touch.clientY, at: event.timeStamp }
      point = { x: touch.clientX, y: touch.clientY }
    }
  }
  const onMove = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined
    if (start === null || touch === undefined) {
      start = null
      return
    }
    if (!dragging && Math.abs(touch.clientY - start.y) < SLOP_PX) {
      return
    }
    dragging = true
    event.preventDefault()
    const dy = last.y - touch.clientY
    velocity = nextVelocity(velocity, dy, event.timeStamp - last.at)
    last = { y: touch.clientY, at: event.timeStamp }
    point = { x: touch.clientX, y: touch.clientY }
    if (dy !== 0) {
      scroll(dy)
    }
  }
  const onEnd = (event: TouchEvent) => {
    if (dragging && flings(velocity, event.timeStamp - last.at)) {
      fling()
    }
    start = null
    dragging = false
  }

  host.addEventListener('touchstart', onStart, { passive: true })
  host.addEventListener('touchmove', onMove, { passive: false })
  host.addEventListener('touchend', onEnd)
  host.addEventListener('touchcancel', onEnd)
  return () => {
    stopFling()
    host.removeEventListener('touchstart', onStart)
    host.removeEventListener('touchmove', onMove)
    host.removeEventListener('touchend', onEnd)
    host.removeEventListener('touchcancel', onEnd)
  }
}
