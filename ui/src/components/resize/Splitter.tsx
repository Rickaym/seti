import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

/** What a drag or key does to the panes on either side of a splitter. */
export interface SplitterControl {
  value: number
  min: number
  max: number
  /** Called as a drag starts, before any `onDrag`, to measure what the drag resizes. */
  onStart: () => void
  /** Shows the size for a drag `delta` pixels from where it began; returns the value it applied. */
  onDrag: (delta: number) => number
  /** Keeps the value a drag ended on. */
  onCommit: (value: number) => void
  /** Handles a key on the focused splitter; returns false to let it pass. */
  onKey: (key: string) => boolean
  /** Double-click puts the panes back to their first sizes. */
  onReset: () => void
}

interface SplitterProps {
  label: string
  /** `vertical` splits panes side by side and moves along x; `horizontal` stacks them. */
  orientation: 'vertical' | 'horizontal'
  control: SplitterControl
  valueText?: string
  className?: string
  style?: CSSProperties
}

interface Drag {
  from: number
  delta: number
  frame: number
}

const RESIZING = 'data-resizing'

/** A window splitter: pointer-captured drags apply once per frame; keys step it when focused. */
export function Splitter({ label, orientation, control, valueText, className, style }: SplitterProps) {
  const element = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const latest = useRef(control)
  useEffect(() => {
    latest.current = control
  })
  useEffect(
    () => () => {
      const pending = drag.current
      if (pending !== null) {
        cancelAnimationFrame(pending.frame)
        document.documentElement.removeAttribute(RESIZING)
      }
    },
    [],
  )

  const along = (event: PointerEvent) => (orientation === 'vertical' ? event.clientX : event.clientY)
  const show = (value: number) => {
    element.current?.setAttribute('aria-valuenow', String(Math.round(value)))
  }

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current === null) {
      return
    }
    drag.current = null
    cancelAnimationFrame(current.frame)
    document.documentElement.removeAttribute(RESIZING)
    const value = latest.current.onDrag(along(event) - current.from)
    show(value)
    latest.current.onCommit(value)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return
    }
    if (latest.current.onKey(event.key)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
     A focusable separator is the ARIA window splitter pattern. */
  return (
    <div
      ref={element}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={Math.round(control.min)}
      aria-valuemax={Math.round(control.max)}
      aria-valuenow={Math.round(control.value)}
      aria-valuetext={valueText}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      data-slot="splitter"
      className={cn(
        'group/splitter relative z-20 touch-none outline-none select-none',
        orientation === 'vertical' ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize',
        className,
      )}
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return
        }
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        latest.current.onStart()
        drag.current = { from: along(event), delta: 0, frame: 0 }
        document.documentElement.setAttribute(RESIZING, orientation)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (current === null) {
          return
        }
        current.delta = along(event) - current.from
        if (current.frame === 0) {
          current.frame = requestAnimationFrame(() => {
            current.frame = 0
            show(latest.current.onDrag(current.delta))
          })
        }
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => {
        latest.current.onReset()
      }}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute bg-primary opacity-0 transition-opacity duration-150 group-hover/splitter:opacity-60 group-focus-visible/splitter:opacity-100 group-active/splitter:opacity-100',
          orientation === 'vertical'
            ? 'inset-y-0 left-1/2 w-0.5 -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-0.5 -translate-y-1/2',
        )}
      />
    </div>
  )
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
     End of the window splitter. */
}
