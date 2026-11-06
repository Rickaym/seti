import type { RunWindowStats } from '@seti/shared'

/** A late or slow time in the unit that reads best: ms, s or min. */
export function shortDuration(ms: number): string {
  if (ms < 1000) {
    return `${String(ms)} ms`
  }
  if (ms < 120_000) {
    return `${String(Math.round(ms / 1000))} s`
  }
  return `${String(Math.round(ms / 60_000))} min`
}

/** One line on how a week went: runs against expected, on time, late, missed, worked. */
export function weekLine(week: RunWindowStats): string {
  if (week.runs === 0) {
    return 'No scheduled run in the last 7 days'
  }
  const counted = week.expected !== null && week.expected >= week.runs ? week.expected : null
  const of = counted === null ? '' : ` of ${String(counted)}`
  const parts = [`${String(week.runs)}${of} ${(counted ?? week.runs) === 1 ? 'run' : 'runs'} in 7 days`]
  if (week.on_time_pct !== null) {
    parts.push(`${String(week.on_time_pct)}% on time`)
  }
  if (week.late_p95_ms !== null && week.late_p95_ms >= 1000) {
    parts.push(`p95 ${shortDuration(week.late_p95_ms)} late`)
  }
  if (week.missed > 0) {
    parts.push(`${String(week.missed)} missed`)
  }
  if (week.ok_pct !== null && week.ok_pct < 100) {
    parts.push(`${String(week.ok_pct)}% worked`)
  }
  return parts.join(', ')
}

/** A poller or reminder past its next run by over an interval; the watchdog re-arms it. */
export const STALE = { label: 'Stale', tone: 'text-warning-text' }
