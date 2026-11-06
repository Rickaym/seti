import {
  cronSchedule,
  nextRunTimes,
  previousRunTime,
  reminderSettingsInput,
  reminderUpdateInput,
  runsBetween,
  scheduleIssue,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'

const FIELDS = 'Schedule needs 5 fields: minute hour day-of-month month day-of-week'

describe('scheduleIssue', () => {
  it.each([
    ['0 9 * * 1-5', 'Europe/Berlin'],
    ['*/15 * * * *', 'UTC'],
    ['30 8 1 * *', 'America/New_York'],
    ['  0 9 * * MON  ', 'Asia/Kathmandu'],
  ])('accepts %j in %s', (cron, timezone) => {
    expect(scheduleIssue(cron, timezone)).toBeNull()
  })

  it.each([
    ['0 0 9 * * 1-5', 'UTC', 'cron', FIELDS],
    ['@daily', 'UTC', 'cron', FIELDS],
    ['61 9 * * *', 'UTC', 'cron', 'Invalid schedule: Invalid value for minute: 61'],
    ['0 9 31 2 *', 'UTC', 'cron', 'Schedule never runs'],
    ['0 9 * * *', 'Mars/Olympus', 'timezone', 'Unknown timezone "Mars/Olympus", use an IANA name like Europe/Berlin'],
  ])('rejects %j in %s', (cron, timezone, path, message) => {
    expect(scheduleIssue(cron, timezone)).toEqual({ path, message })
  })
})

describe('schedule schemas', () => {
  it('trims a valid schedule', () => {
    expect(cronSchedule.parse({ cron: ' 0 9 * * 1-5 ', timezone: 'UTC ' })).toEqual({
      cron: '0 9 * * 1-5',
      timezone: 'UTC',
    })
  })

  it('reports the failing field with a readable message', () => {
    const result = cronSchedule.safeParse({ cron: '0 25 * * *', timezone: 'UTC' })
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['cron'], message: 'Invalid schedule: Invalid value for hour: 25' }),
    ])
    expect(cronSchedule.safeParse({ cron: '0 9 * * *', timezone: 'Nowhere/City' }).error?.issues[0]?.path).toEqual([
      'timezone',
    ])
  })

  it('leaves a reminder on its interval unless it gets a schedule', () => {
    expect(reminderSettingsInput.parse({ script: 'x' })).toMatchObject({ schedule: null })
    const bad = reminderSettingsInput.safeParse({ script: 'x', schedule: { cron: '0 9 * *', timezone: 'UTC' } })
    expect(bad.error?.issues).toEqual([expect.objectContaining({ path: ['schedule', 'cron'], message: FIELDS })])
    expect(reminderUpdateInput.parse({ schedule: null })).toEqual({ schedule: null })
  })
})

describe('nextRunTimes', () => {
  const from = new Date('2026-09-25T10:00:00Z')

  it('returns weekday mornings in the schedule timezone', () => {
    expect(nextRunTimes('0 9 * * 1-5', 'Europe/Berlin', 3, from)).toEqual([
      '2026-09-28T07:00:00.000Z',
      '2026-09-29T07:00:00.000Z',
      '2026-09-30T07:00:00.000Z',
    ])
  })

  it('follows daylight saving changes', () => {
    expect(nextRunTimes('0 9 * * *', 'Europe/Berlin', 2, new Date('2026-10-24T12:00:00Z'))).toEqual([
      '2026-10-25T08:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
    ])
  })

  it('returns hourly runs', () => {
    expect(nextRunTimes('0 * * * *', 'UTC', 3, from)).toEqual([
      '2026-09-25T11:00:00.000Z',
      '2026-09-25T12:00:00.000Z',
      '2026-09-25T13:00:00.000Z',
    ])
  })
})

describe('previousRunTime', () => {
  it('returns the newest slot before a time, or the time itself when it is a slot', () => {
    expect(previousRunTime('0 * * * *', 'UTC', new Date('2026-09-25T10:59:59.999Z'))).toBe('2026-09-25T10:00:00.000Z')
    expect(previousRunTime('0 * * * *', 'UTC', new Date('2026-09-25T11:00:00.000Z'))).toBe('2026-09-25T11:00:00.000Z')
    expect(previousRunTime('0 * * * *', 'UTC', new Date('2026-09-25T11:00:00.400Z'))).toBe('2026-09-25T11:00:00.000Z')
  })

  it('reads the schedule in its timezone', () => {
    expect(previousRunTime('0 9 * * 1-5', 'Europe/Berlin', new Date('2026-09-28T06:00:00Z'))).toBe(
      '2026-09-25T07:00:00.000Z',
    )
  })
})

describe('runsBetween', () => {
  const range = { from: new Date('2026-09-25T10:00:00Z'), to: new Date('2026-09-25T13:00:00Z') }

  it('counts slots after the start and up to the end', () => {
    expect(runsBetween('0 * * * *', 'UTC', range, 100)).toBe(3)
    expect(runsBetween('30 * * * *', 'UTC', range, 100)).toBe(3)
    expect(runsBetween('0 9 * * 1-5', 'Europe/Berlin', range, 100)).toBe(0)
  })

  it('stops at the maximum', () => {
    expect(runsBetween('* * * * *', 'UTC', range, 50)).toBe(50)
  })
})
