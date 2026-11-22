import { cn } from '@/lib/utils'
import type { MeterState } from './hype'

/**
 * A host meter that reads busy as good: the fill flows with colour from half use and rages near
 * full. Trouble holds it still in the warning colour.
 */
export function HypeMeter({
  label,
  percent,
  state,
  className,
}: {
  label: string
  percent: number | null
  state: MeterState
  className?: string
}) {
  const value = Math.min(100, Math.max(0, percent ?? 0))
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      data-hype={state}
      className={cn('hype-meter h-1.5', className)}
    >
      <div className="hype-fill" style={{ width: `${String(value)}%` }}>
        {(state === 'flow' || state === 'rage') && <div className="hype-sweep" />}
      </div>
    </div>
  )
}
