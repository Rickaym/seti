import type { CronSchedule, ReminderSettings } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { sql } from '../db.js'
import { createReminderTicker } from './ticker.js'
import { after, reminderStore } from '../store/reminders.js'

const BERLIN_9AM: CronSchedule = { cron: '0 9 * * *', timezone: 'Europe/Berlin' }
const HOURLY: CronSchedule = { cron: '0 * * * *', timezone: 'UTC' }

let count = 0

async function newReminder(schedule: CronSchedule | null, at = '2026-10-20T06:00:00.000Z', enabled = true) {
  const settings: ReminderSettings = { script: 'export default () => null', interval_s: 600, schedule, enabled }
  const id = `cron-${String(++count)}`
  return reminderStore.create(id, id, settings, at)
}

const nextRunOf = async (id: string) => (await reminderStore.get(id))?.next_run_at ?? null

const setNextRun = async (id: string, at: string | null) => {
  await sql`UPDATE channel_reminder SET next_run_at = ${at} WHERE channel_id = ${id}`
}

const claim = async (id: string, at: string) =>
  (await reminderStore.claimDue(at, 20)).filter((claimed) => claimed.id === id)

describe('cron reminders', () => {
  it('time the first run for the next slot in their timezone, and none while paused', async () => {
    const reminder = await newReminder(BERLIN_9AM)
    expect(reminder).toMatchObject({ schedule: BERLIN_9AM, next_run_at: '2026-10-20T07:00:00.000Z' })
    expect((await newReminder(BERLIN_9AM, undefined, false)).next_run_at).toBeNull()
  })

  it('run at their slot once and move on to the next slot', async () => {
    const reminder = await newReminder(BERLIN_9AM)
    expect(await claim(reminder.id, '2026-10-20T06:59:59.000Z')).toEqual([])
    expect(await claim(reminder.id, '2026-10-20T07:00:04.000Z')).toEqual([
      { id: reminder.id, due_at: '2026-10-20T07:00:00.000Z' },
    ])
    expect(await nextRunOf(reminder.id)).toBe('2026-10-21T07:00:00.000Z')
    expect(await claim(reminder.id, '2026-10-20T07:00:05.000Z')).toEqual([])
  })

  it('run when claimed within the first second of their slot, as a ticker woken for it claims', async () => {
    const slot = [{ due_at: '2026-10-20T07:00:00.000Z' }]
    const exact = await newReminder(BERLIN_9AM)
    expect(await claim(exact.id, '2026-10-20T07:00:00.000Z')).toMatchObject(slot)
    const woken = await newReminder(BERLIN_9AM)
    expect(await claim(woken.id, '2026-10-20T07:00:00.400Z')).toMatchObject(slot)
  })

  it('run the newest missed slot once when it is at most an hour old', async () => {
    const late = await newReminder(BERLIN_9AM)
    expect(await claim(late.id, '2026-10-20T07:30:00.000Z')).toEqual([
      { id: late.id, due_at: '2026-10-20T07:00:00.000Z' },
    ])
    expect(await nextRunOf(late.id)).toBe('2026-10-21T07:00:00.000Z')

    const hourly = await newReminder(HOURLY, '2026-10-20T02:30:00.000Z')
    expect(await nextRunOf(hourly.id)).toBe('2026-10-20T03:00:00.000Z')
    expect(await claim(hourly.id, '2026-10-20T05:20:00.000Z')).toEqual([
      { id: hourly.id, due_at: '2026-10-20T05:00:00.000Z' },
    ])
    expect(await nextRunOf(hourly.id)).toBe('2026-10-20T06:00:00.000Z')
  })

  it('skip slots missed by more than an hour and wait for the next one', async () => {
    const reminder = await newReminder(BERLIN_9AM)
    expect(await claim(reminder.id, '2026-10-20T08:30:00.000Z')).toEqual([])
    expect(await nextRunOf(reminder.id)).toBe('2026-10-21T07:00:00.000Z')
  })

  it('go back to the interval when the schedule is cleared, and onto it when one is set', async () => {
    const reminder = await newReminder(BERLIN_9AM)
    const at = '2026-10-20T06:10:00.000Z'
    expect(await reminderStore.update(reminder.id, { schedule: null }, at)).toMatchObject({
      schedule: null,
      next_run_at: after(at, 600),
    })
    expect(await reminderStore.update(reminder.id, { schedule: HOURLY }, at)).toMatchObject({
      schedule: HOURLY,
      next_run_at: '2026-10-20T07:00:00.000Z',
    })
    expect(await reminderStore.update(reminder.id, { name: 'Renamed' }, at)).toMatchObject({
      schedule: HOURLY,
      next_run_at: '2026-10-20T07:00:00.000Z',
    })
  })

  it('count as overdue a minute past their slot, with no interval of slack', async () => {
    const cron = await newReminder(HOURLY)
    const interval = await newReminder(null)
    await setNextRun(cron.id, '2026-10-20T07:00:00.000Z')
    await setNextRun(interval.id, '2026-10-20T07:00:00.000Z')
    const overdue = (await reminderStore.overdue('2026-10-20T07:02:00.000Z', 60)).map((entry) => entry.id)
    expect(overdue).toContain(cron.id)
    expect(overdue).not.toContain(interval.id)
  })

  it('keep their slot when re-armed, and get the next slot back when they lost it', async () => {
    const kept = await newReminder(HOURLY)
    const lost = await newReminder(HOURLY)
    const interval = await newReminder(null)
    await setNextRun(lost.id, null)
    const at = '2026-10-20T06:20:00.000Z'
    await reminderStore.rearm([kept.id, lost.id, interval.id], at)
    expect(await nextRunOf(kept.id)).toBe('2026-10-20T07:00:00.000Z')
    expect(await nextRunOf(lost.id)).toBe(at)
    expect(await nextRunOf(interval.id)).toBe(at)
    expect(await claim(lost.id, at)).toEqual([])
    expect(await nextRunOf(lost.id)).toBe('2026-10-20T07:00:00.000Z')
  })

  it('reach the ticker with the slot as their due time', async () => {
    const reminder = await newReminder(HOURLY)
    const ran: [string, string | null][] = []
    const clock = { at: Date.parse('2026-10-20T07:00:03.000Z') }
    const ticker = createReminderTicker({
      claimDue: async (at, limit) => (await reminderStore.claimDue(at, limit)).filter((c) => c.id === reminder.id),
      overdue: async () => Promise.resolve([]),
      rearm: async () => Promise.resolve(),
      soonest: async () => Promise.resolve(null),
      run: async (id, _trigger, dueAt) => {
        ran.push([id, dueAt])
        return Promise.resolve()
      },
      concurrency: 1,
      tickMs: 60_000,
      onError: (e) => {
        throw e
      },
      onStale: () => undefined,
      now: () => clock.at,
    })
    await ticker.tick()
    await ticker.tick()
    expect(ran).toEqual([[reminder.id, '2026-10-20T07:00:00.000Z']])
  })
})
