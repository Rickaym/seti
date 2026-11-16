import { nextRuns, runsInRange, type RunTiming } from '@seti/shared'
import { describe, expect, it } from 'vitest'

const at = (iso: string) => new Date(iso)
const DAY = { from: at('2026-03-02T00:00:00.000Z'), to: at('2026-03-03T00:00:00.000Z') }

const every = (interval_s: number, next_run_at: string | null): RunTiming => ({ interval_s, next_run_at })
const cron = (expression: string, timezone = 'UTC'): RunTiming => ({
  interval_s: 3600,
  schedule: { cron: expression, timezone },
  next_run_at: '2026-03-02T00:00:00.000Z',
})

describe('nextRuns', () => {
  it('projects an interval from its stored next run', () => {
    expect(nextRuns(every(300, '2026-03-02T00:02:00.000Z'), DAY.from, 3)).toEqual([
      '2026-03-02T00:02:00.000Z',
      '2026-03-02T00:07:00.000Z',
      '2026-03-02T00:12:00.000Z',
    ])
  })

  it('keeps the grid of an interval whose next run is already due', () => {
    expect(nextRuns(every(3600, '2026-03-01T22:30:00.000Z'), DAY.from, 2)).toEqual([
      '2026-03-02T00:30:00.000Z',
      '2026-03-02T01:30:00.000Z',
    ])
  })

  it('reads a cron schedule in its timezone and ignores the interval', () => {
    expect(nextRuns(cron('0 9 * * 1-5', 'Europe/Berlin'), DAY.from, 2)).toEqual([
      '2026-03-02T08:00:00.000Z',
      '2026-03-03T08:00:00.000Z',
    ])
  })

  it('has nothing to come while paused', () => {
    expect(nextRuns(every(300, null), DAY.from, 3)).toEqual([])
    expect(nextRuns({ ...cron('0 9 * * *'), next_run_at: null }, DAY.from, 3)).toEqual([])
  })
})

describe('runsInRange', () => {
  it('counts every run of a frequent interval and lists only the first ones', () => {
    expect(runsInRange(every(300, '2026-03-02T00:05:00.000Z'), DAY, 2)).toEqual({
      count: 288,
      times: ['2026-03-02T00:05:00.000Z', '2026-03-02T00:10:00.000Z'],
    })
  })

  it('takes a run at the end of the range and leaves out one at its start', () => {
    expect(runsInRange(every(43_200, '2026-03-02T00:00:00.000Z'), DAY, 6)).toEqual({
      count: 2,
      times: ['2026-03-02T12:00:00.000Z', '2026-03-03T00:00:00.000Z'],
    })
  })

  it('finds no run when the next one lies past the range', () => {
    expect(runsInRange(every(86_400, '2026-03-04T10:00:00.000Z'), DAY, 6)).toEqual({ count: 0, times: [] })
  })

  it('counts cron slots and lists a sparse schedule in full', () => {
    expect(runsInRange(cron('*/5 * * * *'), DAY, 1)).toEqual({ count: 288, times: ['2026-03-02T00:05:00.000Z'] })
    expect(runsInRange(cron('0 9,17 * * *', 'America/New_York'), DAY, 6)).toEqual({
      count: 2,
      times: ['2026-03-02T14:00:00.000Z', '2026-03-02T22:00:00.000Z'],
    })
  })

  it('has no runs while paused', () => {
    expect(runsInRange(every(300, null), DAY, 6)).toEqual({ count: 0, times: [] })
  })
})
