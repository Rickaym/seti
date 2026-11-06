import { useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

const WIDTH = 120
const HEIGHT = 32
const PAD = 2

interface SparkPoint {
  at: string
  value: number | null
}

/**
 * A small line of recent values with a hover readout. `max` fixes the top of the scale, as 100
 * for percents; otherwise the largest value sets it.
 */
export function Sparkline({
  label,
  points,
  format,
  max,
  className,
}: {
  label: string
  points: readonly SparkPoint[]
  format: (value: number) => string
  max?: number
  className?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const values = points.map((p) => p.value)
  const known = values.filter((v) => v !== null)
  const top = max ?? Math.max(1, ...known)
  const step = points.length > 1 ? (WIDTH - 2 * PAD) / (points.length - 1) : 0
  const x = (i: number) => PAD + i * step
  const y = (v: number) => HEIGHT - PAD - (Math.min(v, top) / top) * (HEIGHT - 2 * PAD)
  const path = values
    .map((v, i) => (v === null ? null : `${String(x(i))},${String(y(v))}`))
    .filter((p) => p !== null)
    .join(' ')
  const last = known.at(-1)
  const summary =
    last === undefined
      ? `${label}: no readings yet`
      : `${label}: now ${format(last)}, low ${format(Math.min(...known))}, high ${format(Math.max(...known))}`
  const hovered = hover === null ? null : points[hover]
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - box.left) / box.width
    setHover(points.length === 0 ? null : Math.round(ratio * (points.length - 1)))
  }
  return (
    <div className={cn('relative', className)}>
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        className="block h-8 w-full overflow-visible text-primary"
        onPointerMove={onMove}
        onPointerLeave={() => {
          setHover(null)
        }}
      >
        <line x1={0} x2={WIDTH} y1={HEIGHT - PAD} y2={HEIGHT - PAD} className="stroke-border" strokeWidth={1} />
        <polyline
          points={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={0}
            y2={HEIGHT}
            className="stroke-muted-foreground"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {hovered !== undefined && hovered !== null && (
        <div className="pointer-events-none absolute -top-6 right-0 border border-border bg-popover px-1.5 py-0.5 text-2xs whitespace-nowrap text-popover-foreground tabular-nums">
          {new Date(hovered.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' '}
          {hovered.value === null ? '-' : format(hovered.value)}
        </div>
      )}
    </div>
  )
}
