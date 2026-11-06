import type { RunWindowStats } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { channelsTone } from '@/components/status-bar/tone'
import { weekLine } from './schedule-health'

const week = (extra: Partial<RunWindowStats> = {}): RunWindowStats => ({
  days: 7,
  runs: 168,
  expected: 168,
  ok_pct: 100,
  on_time_pct: 100,
  late_p50_ms: 120,
  late_p95_ms: 400,
  late_max_ms: 900,
  missed: 0,
  longest_gap_s: 3601,
  duration_p95_ms: 500,
  errors: [],
  ...extra,
})

describe('schedule health', () => {
  it('says a healthy week in few words', () => {
    expect(weekLine(week())).toBe('168 of 168 runs in 7 days, 100% on time')
  })

  it('names lateness, missed runs and failures when there are any', () => {
    const line = weekLine(week({ runs: 160, on_time_pct: 92.5, late_p95_ms: 45_000, missed: 8, ok_pct: 97.5 }))
    expect(line).toBe('160 of 168 runs in 7 days, 92.5% on time, p95 45 s late, 8 missed, 97.5% worked')
  })

  it('leaves out an expected count a new channel ran past', () => {
    expect(weekLine(week({ runs: 1, expected: 0 }))).toBe('1 run in 7 days, 100% on time')
  })

  it('says when nothing ran on schedule yet', () => {
    expect(weekLine(week({ runs: 0, on_time_pct: null }))).toBe('No scheduled run in the last 7 days')
  })

  it('colours the status bar item red for a failing channel, amber for a stale one', () => {
    const entry = { id: 'a', name: 'Feed', source: 'poller' as const }
    expect(channelsTone({ scheduled: 1, attention: [] })).toBe('default')
    expect(channelsTone({ scheduled: 1, attention: [{ ...entry, problem: 'stale' }] })).toBe('warning')
    expect(channelsTone({ scheduled: 1, attention: [{ ...entry, problem: 'failing' }] })).toBe('danger')
  })
})
