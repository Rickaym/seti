import { useMemo } from 'react'
import { GAP, screenRows, type Metrics, type Rect } from './grid-layout'

interface ScreenSnapsProps {
  perScreen: number | null
  panels: readonly Rect[]
  metrics: Metrics
}

/** Snap points at the top of each screen of a template, so the grid scrolls screen by screen. */
export function ScreenSnaps({ perScreen, panels, metrics }: ScreenSnapsProps) {
  const tops = useMemo(() => {
    if (perScreen === null) {
      return []
    }
    const rows = screenRows(perScreen, metrics)
    const screens = Math.ceil(Math.max(0, ...panels.map((panel) => panel.y + panel.h)) / rows)
    return Array.from({ length: screens }, (_, screen) => screen * rows * (metrics.rowHeight + GAP))
  }, [perScreen, panels, metrics])
  return tops.map((top) => (
    <span
      key={top}
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 h-0 snap-start"
      style={{ top }}
    />
  ))
}
