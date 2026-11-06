import { describe, expect, it } from 'vitest'
import { costBasis, usageLines, usageMeter, usageWords } from './format'

const NOW = Date.parse('2026-10-02T10:00:00Z')
const HOUR = 3_600_000

const window = (key: string, label: string, utilization: number | null, resetsInMs: number | null = null) => ({
  key,
  label,
  utilization,
  resets_at: resetsInMs === null ? null : new Date(NOW + resetsInMs).toISOString(),
})

const fiveHour = (used: number | null) => window('five_hour', '5-hour', used, 4 * HOUR)
const weekly = (used: number | null) => window('seven_day', 'Weekly', used, 3 * 24 * HOUR)

describe('usageMeter', () => {
  it('draws the weekly fill past the 5-hour one when the week is fuller', () => {
    expect(usageMeter([fiveHour(24), weekly(61)])).toEqual({
      primary: { percent: 24, level: 'normal' },
      weekly: { percent: 61, level: 'normal' },
      weeklyAbove: true,
      hottest: null,
    })
  })

  it('keeps the weekly fill under the 5-hour one when the week is emptier', () => {
    expect(usageMeter([fiveHour(70), weekly(30)])).toMatchObject({
      primary: { percent: 70 },
      weekly: { percent: 30 },
      weeklyAbove: false,
    })
  })

  it('levels each fill on its own and clamps to the bar', () => {
    expect(usageMeter([fiveHour(40), weekly(130)])).toMatchObject({
      primary: { percent: 40, level: 'normal' },
      weekly: { percent: 100, level: 'danger' },
    })
    expect(usageMeter([fiveHour(85), weekly(-3)])).toMatchObject({
      primary: { level: 'warning' },
      weekly: { percent: 0, level: 'normal' },
    })
  })

  it('leaves the weekly fill out when the week is unreported', () => {
    expect(usageMeter([fiveHour(24)])).toEqual({
      primary: { percent: 24, level: 'normal' },
      weekly: null,
      weeklyAbove: false,
      hottest: null,
    })
    expect(usageMeter([fiveHour(24), weekly(null)])).toMatchObject({ weekly: null })
  })

  it('draws the weekly fill alone when the 5-hour window is unreported', () => {
    expect(usageMeter([weekly(12)])).toMatchObject({ primary: null, weekly: { percent: 12 }, weeklyAbove: true })
  })

  it('names the fullest per-model window at the warning line as its own bar', () => {
    const opus = window('seven_day_opus', 'Weekly Opus', 82)
    const sonnet = window('seven_day_sonnet', 'Weekly Sonnet', 91)
    const fable = window('model:Fable', 'Weekly Fable', 40)
    const meter = usageMeter([fiveHour(10), weekly(96), opus, sonnet, fable])
    expect(meter?.hottest).toEqual({ window: sonnet, fill: { percent: 91, level: 'warning' } })
    expect(usageMeter([fiveHour(10), weekly(20), fable])?.hottest).toBeNull()
  })

  it('has nothing to draw without any window', () => {
    expect(usageMeter([])).toBeNull()
  })
})

describe('usageWords', () => {
  it('names each drawn window with its percentage and the first reset', () => {
    expect(usageWords([fiveHour(64), weekly(38)], NOW)).toMatch(
      /^5-hour 64%, weekly 38%, 5-hour resets \d\d:\d\d( [AP]M)?$/,
    )
  })

  it('adds the hottest other window and leaves out quiet and unreported ones', () => {
    const opus = window('seven_day_opus', 'Weekly Opus', 96)
    const sonnet = window('seven_day_sonnet', 'Weekly Sonnet', 85)
    const fable = window('model:Fable', 'Weekly Fable', 12)
    expect(usageWords([fiveHour(null), weekly(30), opus, sonnet, fable], NOW)).toMatch(
      /^weekly 30%, weekly Opus 96%, weekly resets \w+ \d\d:\d\d( [AP]M)?$/,
    )
  })

  it('is empty without a reported window', () => {
    expect(usageWords([fiveHour(null)], NOW)).toBe('')
  })
})

describe('usageLines', () => {
  it('says each drawn window with its reset', () => {
    expect(usageLines([fiveHour(64), weekly(38)], NOW)).toEqual([
      expect.stringMatching(/^5-hour: 64%, resets in 4h 0m \(/),
      expect.stringMatching(/^Weekly: 38%, resets in 3d 0h \(/),
    ])
  })
})

describe('costBasis', () => {
  const account = (subscription: string | null) => ({
    email: 'me@example.com',
    organization: null,
    subscription_type: subscription,
    token_source: 'claude.ai',
    api_key_source: null,
    api_provider: 'firstParty',
  })
  const ok = { state: 'ok', message: '' } as const

  it('calls the cost notional on a subscription plan', () => {
    expect(costBasis({ account: account('max'), health: ok })).toBe(
      'Notional: your Max plan covers it; this is the API price',
    )
  })

  it('calls it an estimate when an API key pays per token or the plan is unknown', () => {
    const estimate = 'Estimate at API prices, across all its sessions'
    expect(costBasis({ account: account('max'), health: { state: 'api_key', message: '' } })).toBe(estimate)
    expect(costBasis({ account: account(null), health: ok })).toBe(estimate)
    expect(costBasis(undefined)).toBe(estimate)
  })
})
