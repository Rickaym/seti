/** Where the pad's window sits and how large it is, in CSS pixels from the viewport's top left. */
export interface Frame {
  x: number
  y: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

/** A side or corner a resize drags: north, south, east, west or two of them. */
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const MIN_WIDTH = 220
export const MIN_HEIGHT = 160
/** What the window keeps clear of the viewport's edges. */
const MARGIN = 8
/** The rail the window opens beside, so it never covers the icon that opened it. */
const RAIL_WIDTH = 48
const FIRST = { width: 320, height: 360 }

const between = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))

/** The frame moved and shrunk as little as needed to sit wholly inside the viewport. */
export function clampFrame(frame: Frame, view: Viewport): Frame {
  const width = between(frame.width, MIN_WIDTH, view.width - 2 * MARGIN)
  const height = between(frame.height, MIN_HEIGHT, view.height - 2 * MARGIN)
  return {
    width,
    height,
    x: between(frame.x, MARGIN, view.width - width - MARGIN),
    y: between(frame.y, MARGIN, view.height - height - MARGIN),
  }
}

/** Where the window first opens: beside the rail, near the bottom where the Pad icon is. */
export const firstFrame = (view: Viewport): Frame =>
  clampFrame({ x: RAIL_WIDTH + MARGIN, y: view.height - FIRST.height - 48, ...FIRST }, view)

export const moved = (frame: Frame, dx: number, dy: number): Frame => ({ ...frame, x: frame.x + dx, y: frame.y + dy })

/** The frame with one side or corner dragged by dx and dy, never smaller than the minimum. */
export function resized(frame: Frame, edge: Edge, dx: number, dy: number): Frame {
  let { x, y, width, height } = frame
  if (edge.includes('e')) {
    width = Math.max(MIN_WIDTH, width + dx)
  }
  if (edge.includes('w')) {
    width = Math.max(MIN_WIDTH, frame.width - dx)
    x = frame.x + frame.width - width
  }
  if (edge.includes('s')) {
    height = Math.max(MIN_HEIGHT, height + dy)
  }
  if (edge.includes('n')) {
    height = Math.max(MIN_HEIGHT, frame.height - dy)
    y = frame.y + frame.height - height
  }
  return { x, y, width, height }
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** A frame read back from storage, or null when it is missing or not a frame. */
export function frameOf(value: unknown): Frame | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { x, y, width, height } = value as Record<string, unknown>
  return isNumber(x) && isNumber(y) && isNumber(width) && isNumber(height) ? { x, y, width, height } : null
}
