import { useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { SplitterControl } from '@/components/resize/Splitter'
import {
  clampWidth,
  forgetWidth,
  keyedWidth,
  storedWidth,
  storeWidth,
  type PaneSide,
  type PaneSpec,
} from '@/lib/pane-size'

interface PaneResize {
  /** Sets `--pane-w` and `--pane-max`; size the pane with `w-(--pane-w) max-w-(--pane-max)`. */
  style: CSSProperties
  control: SplitterControl
}

/** The width of the pane in `pane`, kept per `spec`; dragging restyles it without re-rendering. */
export function usePaneResize(pane: RefObject<HTMLElement | null>, spec: PaneSpec, side: PaneSide): PaneResize {
  const [width, setWidth] = useState(() => storedWidth(spec))
  const drag = useRef({ from: width, room: 0 })
  const measure = () => {
    const element = pane.current
    return {
      width: element?.getBoundingClientRect().width ?? width,
      room: element?.parentElement?.getBoundingClientRect().width ?? 0,
    }
  }
  const apply = (next: number) => {
    pane.current?.style.setProperty('--pane-w', `${String(next)}px`)
  }
  const keep = (next: number) => {
    apply(next)
    setWidth(next)
    storeWidth(spec, next)
  }
  return {
    style: { '--pane-w': `${String(width)}px`, '--pane-max': `${String(spec.share * 100)}%` } as CSSProperties,
    control: {
      value: width,
      min: spec.min,
      max: spec.max,
      onStart: () => {
        const now = measure()
        drag.current = { from: now.width, room: now.room }
      },
      onDrag: (delta) => {
        const { from, room } = drag.current
        const next = clampWidth(from + (side === 'start' ? delta : -delta), spec, room)
        apply(next)
        return next
      },
      onCommit: keep,
      onKey: (key) => {
        const now = measure()
        const next = keyedWidth(key, spec, side, now)
        if (next === null) {
          return false
        }
        keep(next)
        return true
      },
      onReset: () => {
        forgetWidth(spec)
        apply(spec.initial)
        setWidth(spec.initial)
      },
    },
  }
}
