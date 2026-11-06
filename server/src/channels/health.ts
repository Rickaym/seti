import {
  CHANNEL_HEALTH_DAYS,
  runsBetween,
  type ChannelAttention,
  type ChannelHealth,
  type ChannelProblem,
  type ChannelsSummary,
  type CronSchedule,
  type RunWindowStats,
} from '@seti/shared'
import { sql } from '../db.js'
import { pollerStore } from '../store/pollers.js'
import { reminderStore } from '../store/reminders.js'

type ScheduledSource = 'poller' | 'reminder'

/** What health needs to know of a poller or reminder besides its runs. */
export interface HealthSubject {
  source: ScheduledSource
  id: string
  created_at: string
  interval_s: number
  /** A reminder's cron schedule, which replaces the interval while set. */
  schedule?: CronSchedule | null
  enabled: boolean
  next_run_at: string | null
}

type Timing = Pick<HealthSubject, 'interval_s' | 'schedule' | 'enabled' | 'next_run_at'>

const onCron = (subject: Timing) => (subject.schedule ?? null) !== null

const DAY_MS = 24 * 60 * 60 * 1000
/** How far past one interval a next run may slip before the channel counts as stale. */
const STALE_MARGIN_S = 60

/** A run is on time when it starts within a tenth of its interval of its due time, 5 to 60 s. */
export const onTimeToleranceS = (intervalS: number) => Math.min(60, Math.max(5, intervalS / 10))

/** Cron slots counted per window at most: a month of every minute. */
const MAX_SLOTS = 31 * 24 * 60

/** How many runs the schedule wanted between two times. */
function expectedRuns(subject: HealthSubject, fromMs: number, toMs: number): number {
  const schedule = subject.schedule ?? null
  if (schedule === null) {
    return Math.floor((toMs - fromMs) / (subject.interval_s * 1000))
  }
  return runsBetween(schedule.cron, schedule.timezone, { from: new Date(fromMs), to: new Date(toMs) }, MAX_SLOTS)
}

interface StatsRow {
  runs: number
  all_runs: number
  ok_runs: number
  timed: number
  on_time: number
  late_p50: number | null
  late_p95: number | null
  late_max: number | null
  longest_gap: number | null
  missed: number
  duration_p95: number | null
}

const round = (value: number | null, scale = 1) => (value === null ? null : Math.round(value * scale))

const percent = (part: number, whole: number) => (whole === 0 ? null : Math.round((1000 * part) / whole) / 10)

async function windowStats(subject: HealthSubject, days: number, now: number): Promise<RunWindowStats> {
  const since = new Date(now - days * DAY_MS).toISOString()
  const { id } = subject
  const runs =
    subject.source === 'poller'
      ? sql`SELECT started_at::timestamptz AS started, due_at::timestamptz AS due, ok, duration_ms, error, trigger
          FROM channel_poller_run WHERE channel_id = ${id} AND started_at >= ${since}`
      : sql`SELECT started_at::timestamptz AS started, due_at::timestamptz AS due,
          outcome IN ('ok', 'empty') AS ok, duration_ms, error, trigger
          FROM channel_reminder_run WHERE channel_id = ${id} AND started_at >= ${since}`
  const tolerance = onCron(subject) ? 60 : onTimeToleranceS(subject.interval_s)
  const [row] = await sql<StatsRow[]>`WITH runs AS (${runs}),
      sched AS (SELECT started, due, lag(started) OVER (ORDER BY started) AS prev FROM runs WHERE trigger = 'schedule'),
      late AS (SELECT extract(epoch FROM started - due)::float8 AS s FROM sched WHERE due IS NOT NULL)
    SELECT (SELECT count(*) FROM sched)::int AS runs,
      (SELECT count(*) FROM runs)::int AS all_runs,
      (SELECT count(*) FILTER (WHERE ok) FROM runs)::int AS ok_runs,
      (SELECT count(*) FROM late)::int AS timed,
      (SELECT count(*) FILTER (WHERE s <= ${tolerance}) FROM late)::int AS on_time,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s) FROM late) AS late_p50,
      (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY s) FROM late) AS late_p95,
      (SELECT max(s) FROM late) AS late_max,
      (SELECT max(extract(epoch FROM started - prev))::float8 FROM sched) AS longest_gap,
      (SELECT coalesce(sum(greatest(0, round(extract(epoch FROM started - prev) / ${subject.interval_s}) - 1)), 0)
        FROM sched)::int AS missed,
      (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FROM runs) AS duration_p95`
  if (row === undefined) {
    throw new Error('Run statistics came back empty')
  }
  const errors = await sql<{ error: string; count: number }[]>`WITH runs AS (${runs})
    SELECT left(error, 120) AS error, count(*)::int AS count FROM runs WHERE error IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 3`
  const expected = expectedRuns(subject, Math.max(Date.parse(subject.created_at), Date.parse(since)), now)
  return {
    days,
    runs: row.runs,
    expected: subject.enabled ? expected : null,
    ok_pct: percent(row.ok_runs, row.all_runs),
    on_time_pct: percent(row.on_time, row.timed),
    late_p50_ms: round(row.late_p50, 1000),
    late_p95_ms: round(row.late_p95, 1000),
    late_max_ms: round(row.late_max, 1000),
    missed: onCron(subject) ? Math.max(0, expected - row.runs) : row.missed,
    longest_gap_s: round(row.longest_gap),
    duration_p95_ms: round(row.duration_p95),
    errors: [...errors],
  }
}

/** How far the next run is past due; null while paused. */
function overdueS(subject: Timing, now: number): number | null {
  const next = subject.next_run_at === null ? null : Date.parse(subject.next_run_at)
  return subject.enabled && next !== null ? Math.max(0, Math.round((now - next) / 1000)) : null
}

/** Enabled, with no next run or one a minute past, plus an interval when it runs on one. */
const isStale = (subject: Timing, now: number) =>
  subject.enabled &&
  (subject.next_run_at === null ||
    (overdueS(subject, now) ?? 0) > (onCron(subject) ? 0 : subject.interval_s) + STALE_MARGIN_S)

/** How a poller or reminder kept its schedule lately, and whether it is stale now. */
export async function channelHealth(subject: HealthSubject, now = Date.now()): Promise<ChannelHealth> {
  return {
    stale: isStale(subject, now),
    overdue_s: overdueS(subject, now),
    windows: await Promise.all(CHANNEL_HEALTH_DAYS.map(async (days) => windowStats(subject, days, now))),
  }
}

interface Scheduled extends Timing {
  id: string
  name: string
  failing: boolean
  failures: number
}

function problemOf(record: Scheduled, now: number): ChannelProblem | null {
  if (!record.enabled) {
    return null
  }
  if (record.failing) {
    return 'failing'
  }
  if (isStale(record, now)) {
    return 'stale'
  }
  return record.failures > 0 ? 'erroring' : null
}

/** How many pollers and reminders there are, and the ones failing, erroring or stale. */
export async function channelsSummary(now = Date.now()): Promise<ChannelsSummary> {
  const tagged = (source: ChannelAttention['source']) => (record: Scheduled) => ({ record, source })
  const all = [
    ...(await pollerStore.list()).map(tagged('poller')),
    ...(await reminderStore.list()).map(tagged('reminder')),
  ]
  const attention = all.flatMap(({ record, source }): ChannelAttention[] => {
    const problem = problemOf(record, now)
    return problem === null ? [] : [{ id: record.id, name: record.name, source, problem }]
  })
  return { scheduled: all.length, attention }
}
