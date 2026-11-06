import type { HomeDay, HomeSummary, HomeTally } from '@seti/shared'
import { Flame, GitMerge } from 'lucide-react'
import { usd } from '@/lib/money'
import { durationLabel } from '@/lib/time'
import { cn } from '@/lib/utils'

const DAY_LABEL = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

const dayLabel = (day: HomeDay) => {
  const date = new Date(`${day.day}T12:00:00`)
  const name = Number.isNaN(date.getTime()) ? day.day : DAY_LABEL.format(date)
  return `${name}: ${String(day.merged)} merged, ${String(day.turns)} turns`
}

/** Deeper fills for busier days, so a run of merges reads at a glance. */
function cellFill(merged: number): string {
  if (merged === 0) {
    return 'bg-muted'
  }
  if (merged === 1) {
    return 'bg-primary/45'
  }
  return merged === 2 ? 'bg-primary/70' : 'bg-primary'
}

function Streak({ summary }: { summary: HomeSummary }) {
  const streak = summary.streak_days
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-sm">
        <Flame className={cn('size-4', streak > 0 ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
        {streak > 0 ? (
          <span>
            <span className="font-semibold tabular-nums">{streak}</span>-day merge streak
          </span>
        ) : (
          <span className="text-muted-foreground">No merge today or yesterday</span>
        )}
      </p>
      <ol aria-label="PRs merged per day, last 30 days" className="flex gap-[3px]">
        {summary.days.map((day) => (
          <li
            key={day.day}
            title={dayLabel(day)}
            aria-label={dayLabel(day)}
            className={cn('h-4 min-w-0 flex-1', cellFill(day.merged))}
          />
        ))}
      </ol>
      <p aria-hidden className="flex justify-between text-2xs text-muted-foreground">
        <span>30 days ago</span>
        <span>Today</span>
      </p>
    </div>
  )
}

const ROWS: [label: string, value: (tally: HomeTally, span: '7d' | '30d') => string][] = [
  ['Merged', (t, s) => String(s === '7d' ? t.merged_7d : t.merged_30d)],
  ['Turns', (t, s) => String(s === '7d' ? t.turns_7d : t.turns_30d)],
  ['Running', (t, s) => durationLabel(s === '7d' ? t.run_ms_7d : t.run_ms_30d)],
  ['Cost', (t, s) => usd(s === '7d' ? t.cost_7d_usd : t.cost_30d_usd)],
]

function Tally({ totals }: { totals: HomeTally }) {
  return (
    <table className="w-full text-xs tabular-nums">
      <thead>
        <tr className="text-muted-foreground">
          <th scope="col" className="py-1 text-left font-normal">
            <span className="sr-only">Measure</span>
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            7 days
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            30 days
          </th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map(([label, value]) => (
          <tr key={label} className="border-t border-border">
            <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
              {label}
            </th>
            <td className={cn('py-1.5 text-right', label === 'Merged' && 'text-base font-semibold')}>
              {value(totals, '7d')}
            </td>
            <td className={cn('py-1.5 text-right', label === 'Merged' && 'text-base font-semibold')}>
              {value(totals, '30d')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** What the agents shipped: the merge streak, a month of days, and totals for the week and month. */
export function HomeMetrics({ summary }: { summary: HomeSummary }) {
  return (
    <section aria-labelledby="home-shipped" className="flex flex-col gap-3">
      <h2 id="home-shipped" className="flex items-center gap-1.5 text-sm font-semibold">
        <GitMerge className="size-4" aria-hidden />
        Shipped
      </h2>
      <Streak summary={summary} />
      <Tally totals={summary.totals} />
    </section>
  )
}
