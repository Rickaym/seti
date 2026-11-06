/** The windows, in days, a poller's or reminder's health covers. */
export const CHANNEL_HEALTH_DAYS = [7, 30] as const

/** How long run rows stay for health; only the newest runs keep their logs. */
export const CHANNEL_RUN_HISTORY_DAYS = 30

/** How a poller or reminder kept its schedule over a window of days. */
export interface RunWindowStats {
  days: number
  /** Scheduled runs that started in the window. */
  runs: number
  /** Runs its interval allows since the window or the channel began; null while paused. */
  expected: number | null
  /** Runs of any trigger that worked, in percent; null without runs. */
  ok_pct: number | null
  /** Scheduled runs that started within tolerance of their due time, of those that have one. */
  on_time_pct: number | null
  late_p50_ms: number | null
  late_p95_ms: number | null
  late_max_ms: number | null
  /** Whole intervals that passed between two scheduled runs with no run. */
  missed: number
  longest_gap_s: number | null
  duration_p95_ms: number | null
  /** The most common errors, newest wording first among equals. */
  errors: { error: string; count: number }[]
}

/** Whether a poller or reminder keeps its schedule now, and how it kept it lately. */
export interface ChannelHealth {
  /** Enabled, with no next run or one over an interval and a minute past. */
  stale: boolean
  /** How far the next run is past due; null while paused, 0 when not due yet. */
  overdue_s: number | null
  windows: RunWindowStats[]
}

/** What is wrong with a poller or reminder that needs a look. */
export type ChannelProblem = 'stale' | 'failing' | 'erroring'

export interface ChannelAttention {
  id: string
  name: string
  source: 'poller' | 'reminder'
  problem: ChannelProblem
}

/** Pollers and reminders at a glance, for the status bar: how many run, and which need a look. */
export interface ChannelsSummary {
  scheduled: number
  attention: ChannelAttention[]
}
