import type { UiModApi } from '@seti/mod-api'
import { Grip, X } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { PadWindowState } from './pad-window.js'
import { clampFrame, moved, resized, type Edge, type Frame } from './window-frame.js'

/** How far one arrow key moves or resizes the window. */
const STEP = 16

const HANDLES: readonly { edge: Edge; className: string }[] = [
  { edge: 'n', className: '-top-1 inset-x-3 h-2 cursor-ns-resize' },
  { edge: 's', className: '-bottom-1 inset-x-3 h-2 cursor-ns-resize' },
  { edge: 'e', className: '-right-1 inset-y-3 w-2 cursor-ew-resize' },
  { edge: 'w', className: '-left-1 inset-y-3 w-2 cursor-ew-resize' },
  { edge: 'nw', className: '-top-1 -left-1 size-3 cursor-nwse-resize' },
  { edge: 'ne', className: '-top-1 -right-1 size-3 cursor-nesw-resize' },
  { edge: 'sw', className: '-bottom-1 -left-1 size-3 cursor-nesw-resize' },
  { edge: 'se', className: '-right-1 -bottom-1 size-3 cursor-nwse-resize' },
]

const ARROWS: Readonly<Record<string, [number, number]>> = {
  ArrowLeft: [-STEP, 0],
  ArrowRight: [STEP, 0],
  ArrowUp: [0, -STEP],
  ArrowDown: [0, STEP],
}

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

interface Drag {
  pointer: number
  fromX: number
  fromY: number
  start: Frame
  edge: Edge | null
}

/** The window's frame on screen: dragged and resized live, kept by the device when a change ends. */
function useFrame(place: PadWindowState) {
  const [frame, setFrame] = useState(() => place.frame())
  const drag = useRef<Drag | null>(null)
  useEffect(() => {
    const fit = () => {
      setFrame((current) => clampFrame(current, viewport()))
    }
    window.addEventListener('resize', fit)
    return () => {
      window.removeEventListener('resize', fit)
    }
  }, [])
  const begin = (edge: Edge | null) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointer: event.pointerId, fromX: event.clientX, fromY: event.clientY, start: frame, edge }
  }
  const follow = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (current?.pointer !== event.pointerId) {
      return
    }
    const [dx, dy] = [event.clientX - current.fromX, event.clientY - current.fromY]
    const next = current.edge === null ? moved(current.start, dx, dy) : resized(current.start, current.edge, dx, dy)
    setFrame(clampFrame(next, viewport()))
  }
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointer === event.pointerId) {
      drag.current = null
      place.setFrame(frame)
    }
  }
  const step = (event: KeyboardEvent<HTMLElement>) => {
    const arrow = ARROWS[event.key]
    if (arrow === undefined || event.altKey || event.ctrlKey || event.metaKey) {
      return
    }
    event.preventDefault()
    const [dx, dy] = arrow
    const next = clampFrame(event.shiftKey ? resized(frame, 'se', dx, dy) : moved(frame, dx, dy), viewport())
    setFrame(next)
    place.setFrame(next)
  }
  const pointer = { onPointerMove: follow, onPointerUp: end, onPointerCancel: end }
  return { frame, begin, pointer, step }
}

interface PadWindowProps {
  api: UiModApi
  place: PadWindowState
  onClose: () => void
  children: ReactNode
}

/**
 * The pad as a window over the page: its header drags it, its edges and corners resize it, arrow
 * keys on the header move it and Shift with them resizes it, and Esc inside it closes it.
 */
export function PadWindow({ api, place, onClose, children }: PadWindowProps) {
  const { frame, begin, pointer, step } = useFrame(place)
  const [element, setElement] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (element === null) {
      return undefined
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    element.addEventListener('keydown', onKeyDown)
    return () => {
      element.removeEventListener('keydown', onKeyDown)
    }
  }, [element, onClose])
  const { Hint } = api.kit
  return (
    <section
      ref={setElement}
      aria-label="Pad"
      data-pad-window=""
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
      className="fixed z-50 flex flex-col border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="flex h-8 shrink-0 items-center border-b border-border">
        <Hint text="Drag to move. Arrow keys move it, Shift with them resizes it">
          <button
            type="button"
            aria-label="Move pad"
            className="flex h-full min-w-0 flex-1 cursor-move touch-none items-center gap-2 px-2 text-xs text-muted-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onPointerDown={begin(null)}
            onKeyDown={step}
            {...pointer}
          >
            <Grip className="size-3.5 shrink-0" />
            Pad
          </button>
        </Hint>
        <button
          type="button"
          aria-label="Close pad"
          className="flex size-8 shrink-0 items-center justify-center text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {HANDLES.map(({ edge, className }) => (
        <div
          key={edge}
          aria-hidden
          data-resize={edge}
          className={`absolute touch-none ${className}`}
          onPointerDown={begin(edge)}
          {...pointer}
        />
      ))}
    </section>
  )
}
