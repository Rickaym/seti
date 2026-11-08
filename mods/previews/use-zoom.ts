import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { Drawn } from './use-rendered'

const ZOOM_STEP = 1.25
export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 8
const FRAME_PADDING = 24

/** Mouse drags scroll the frame; touch keeps its native scrolling. */
function usePan() {
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  return {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) {
        return
      }
      const frame = e.currentTarget
      drag.current = { x: e.clientX, y: e.clientY, left: frame.scrollLeft, top: frame.scrollTop }
      frame.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const from = drag.current
      if (from !== null) {
        e.currentTarget.scrollTo(from.left - (e.clientX - from.x), from.top - (e.clientY - from.y))
      }
    },
    onPointerUp: () => {
      drag.current = null
    },
    onPointerCancel: () => {
      drag.current = null
    },
  }
}

function useFrameWidth() {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (frame === null) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      setWidth(frame.clientWidth)
    })
    observer.observe(frame)
    return () => {
      observer.disconnect()
    }
  }, [frame])
  return { setFrame, width }
}

/**
 * Zoom for a drawn diagram: fitted to its frame's width at first, never past its own size, then
 * zoomed in steps; the frame scrolls and a mouse drags it.
 */
export function useZoom(drawn: Drawn | null) {
  const [zoom, setZoom] = useState<number | null>(null)
  const { setFrame, width } = useFrameWidth()
  const pan = usePan()
  const fit =
    drawn === null || drawn.width === 0 ? 1 : Math.min(1, Math.max(ZOOM_MIN, (width - FRAME_PADDING) / drawn.width))
  const scale = zoom ?? fit
  return {
    scale,
    frame: { ref: setFrame, ...pan },
    size: drawn === null ? null : { width: drawn.width * scale, height: drawn.height * scale },
    zoomOut: () => {
      setZoom(Math.max(ZOOM_MIN, scale / ZOOM_STEP))
    },
    zoomIn: () => {
      setZoom(Math.min(ZOOM_MAX, scale * ZOOM_STEP))
    },
    fitWidth: () => {
      setZoom(null)
    },
  }
}

export type Zoom = ReturnType<typeof useZoom>
