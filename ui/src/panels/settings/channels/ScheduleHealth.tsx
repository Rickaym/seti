import type { ChannelHealth } from '@seti/shared'
import { cn } from '@/lib/utils'
import { SettingRow } from '../layout'
import { shortDuration, weekLine } from './schedule-health'

const tone = (pct: number | null) => {
  if (pct === null) {
    return 'text-muted-foreground'
  }
  return pct >= 95 ? 'text-success' : 'text-warning-text'
}

/** How a poller or reminder kept its schedule this week, and the month's on-time rate beside it. */
export function ScheduleHealth({ health }: { health: ChannelHealth }) {
  const [week, month] = health.windows
  if (week === undefined) {
    return null
  }
  const stale =
    health.stale && health.overdue_s !== null
      ? `Overdue ${shortDuration(health.overdue_s * 1000)}; Seti re-arms it within a minute. `
      : ''
  const pct = month?.on_time_pct ?? null
  return (
    <SettingRow label="On time" description={`${stale}${weekLine(week)}`}>
      <span
        className={cn('font-semibold tabular-nums', health.stale ? 'text-warning-text' : tone(pct))}
        data-testid="schedule-on-time"
        title="Runs that started on time in the last 30 days"
      >
        {pct === null ? '--' : `${String(pct)}%`}
      </span>
    </SettingRow>
  )
}
