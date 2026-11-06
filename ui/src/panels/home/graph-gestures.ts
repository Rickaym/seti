import type { SimNode } from './graph-sim'

/** What the gestures act on, in CSS pixels from the canvas corner. */
export interface GestureTarget {
  nodeAt: (px: number, py: number, slop: number) => SimNode | null
  moveView: (dx: number, dy: number, scale?: number, about?: [number, number]) => void
  drag: (node: SimNode, px: number | null, py: number | null) => void
  hover: (node: SimNode | null) => void
  tap: (node: SimNode | null, touch: boolean) => void
}

type Point = [number, number]

interface Press {
  start: Point
  at: number
  node: SimNode | null
  moved: boolean
  touch: boolean
}

interface Pinch {
  distance: number
  mid: Point
}

/** A press that moves less than this stays a tap. */
const TAP_MOVE = 6
const TAP_MS = 500
/** How far from a node a pointer still picks it; a finger is wider than a mouse. */
const MOUSE_SLOP = 6
const TOUCH_SLOP = 14
const WHEEL_RATE = 0.0015
const WHEEL_LINE_RATE = 0.05

/** Pan, pinch or wheel to zoom, drag a node, tap or click it; returns the teardown. */
export function attachGestures(canvas: HTMLCanvasElement, target: GestureTarget): () => void {
  const pointers = new Map<number, Point>()
  let press: Press | null = null
  let pinch: Pinch | null = null

  const local = (e: PointerEvent | WheelEvent): Point => {
    const box = canvas.getBoundingClientRect()
    return [e.clientX - box.left, e.clientY - box.top]
  }

  const pinchOf = (): Pinch => {
    const [a = [0, 0], b = [0, 0]] = [...pointers.values()]
    return { distance: Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), 1), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }
  }

  const release = (tapped: boolean) => {
    if (press === null) {
      return
    }
    if (press.node !== null) {
      target.drag(press.node, null, null)
    }
    if (tapped && !press.moved && performance.now() - press.at < TAP_MS) {
      target.tap(press.node, press.touch)
    }
    press = null
  }

  const down = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId)
    const point = local(e)
    pointers.set(e.pointerId, point)
    if (pointers.size === 1) {
      const touch = e.pointerType !== 'mouse'
      press = {
        start: point,
        at: performance.now(),
        node: target.nodeAt(...point, touch ? TOUCH_SLOP : MOUSE_SLOP),
        moved: false,
        touch,
      }
      return
    }
    release(false)
    pinch = pinchOf()
  }

  const hover = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') {
      return
    }
    const node = target.nodeAt(...local(e), MOUSE_SLOP)
    target.hover(node)
    canvas.style.setProperty('cursor', node === null ? 'grab' : 'pointer')
  }

  const move = (e: PointerEvent) => {
    const before = pointers.get(e.pointerId)
    if (before === undefined) {
      hover(e)
      return
    }
    const point = local(e)
    pointers.set(e.pointerId, point)
    if (pinch !== null && pointers.size >= 2) {
      const next = pinchOf()
      target.moveView(next.mid[0] - pinch.mid[0], next.mid[1] - pinch.mid[1], next.distance / pinch.distance, pinch.mid)
      pinch = next
      return
    }
    if (press === null) {
      return
    }
    press.moved ||= Math.hypot(point[0] - press.start[0], point[1] - press.start[1]) > TAP_MOVE
    if (!press.moved) {
      return
    }
    if (press.node === null) {
      canvas.style.setProperty('cursor', 'grabbing')
      target.moveView(point[0] - before[0], point[1] - before[1])
    } else {
      target.drag(press.node, ...point)
    }
  }

  const up = (tapped: boolean) => (e: PointerEvent) => {
    pointers.delete(e.pointerId)
    if (pointers.size < 2) {
      pinch = null
    }
    if (pointers.size === 0) {
      release(tapped)
      canvas.style.removeProperty('cursor')
    }
  }

  const leave = () => {
    if (pointers.size === 0) {
      target.hover(null)
    }
  }

  const wheel = (e: WheelEvent) => {
    e.preventDefault()
    const rate = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_RATE : WHEEL_RATE
    target.moveView(0, 0, Math.exp(-e.deltaY * rate), local(e))
  }

  const ended = up(true)
  const cancelled = up(false)
  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', ended)
  canvas.addEventListener('pointercancel', cancelled)
  canvas.addEventListener('pointerleave', leave)
  canvas.addEventListener('wheel', wheel, { passive: false })
  return () => {
    canvas.removeEventListener('pointerdown', down)
    canvas.removeEventListener('pointermove', move)
    canvas.removeEventListener('pointerup', ended)
    canvas.removeEventListener('pointercancel', cancelled)
    canvas.removeEventListener('pointerleave', leave)
    canvas.removeEventListener('wheel', wheel)
  }
}
