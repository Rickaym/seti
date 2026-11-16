import type { HomeDay, HomeSummary, HomeTally } from '@seti/shared'
import { Flame, GitMerge } from 'lucide-react'
import { Sparkline } from '@/components/Sparkline'
import { usd } from '@/lib/money'
import { durationLabel } from '@/lib/time'
import { cn } from '@/lib/utils'

const DAY_LABEL = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

const dayName = (day: string) => {
  const date = new Date(`${day}T12:00:00`)
  return Number.isNaN(date.getTime()) ? day : DAY_LABEL.format(date)
}

type DayMeasure = 'merged' | 'turns'

function counted(unit: DayMeasure, value: number): string {
  if (unit === 'merged') {
    return `${String(value)} merged`
  }
  return `${String(value)} ${value === 1 ? 'turn' : 'turns'}`
}

/** One measure a day for the month, on its own scale so a few merges never sit flat under turns. */
function DayLine({ label, unit, days }: { label: string; unit: DayMeasure; days: HomeDay[] }) {
  const points = days.map((day) => ({ at: day.day, value: day[unit] }))
  const peak = Math.max(0, ...points.map((p) => p.value))
  return (
    <div className="flex flex-col gap-0.5">
      <p className="flex items-baseline justify-between text-xs">
        <span>{label}</span>
        <span className="text-2xs text-muted-foreground tabular-nums">peak {peak}</span>
      </p>
      <Sparkline
        label={`${label} per day, last 30 days`}
        points={points}
        format={(value) => counted(unit, value)}
        when={dayName}
      />
    </div>
  )
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
      <DayLine label="Turns" unit="turns" days={summary.days} />
      <DayLine label="Merged" unit="merged" days={summary.days} />
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

/** What the agents shipped: the streak, a month of turns and merges, and week and month totals. */
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
