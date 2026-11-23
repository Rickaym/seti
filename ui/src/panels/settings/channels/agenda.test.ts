import type {
  ChannelInfo,
  ChannelSubscription,
  ChannelTarget,
  CronSchedule,
  DeliveryTiming,
  EaFollowup,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { buildAgenda } from './agenda'

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const local = (day: number, hour: number, minute = 0) => new Date(2026, 5, day, hour, minute)
const NOW = local(1, 10)

const poller = (name: string, interval_s: number, next: Date | null) =>
  ({
    source: 'poller',
    id: name,
    name,
    subscriptions: [] as ChannelSubscription[],
    poller: { enabled: next !== null, interval_s, next_run_at: next?.toISOString() ?? null },
  }) as ChannelInfo

const reminder = (name: string, interval_s: number, next: Date | null, schedule: CronSchedule | null = null) =>
  ({
    source: 'reminder',
    id: name,
    name,
    subscriptions: [] as ChannelSubscription[],
    reminder: { enabled: next !== null, interval_s, schedule, next_run_at: next?.toISOString() ?? null },
  }) as ChannelInfo

const followup = (id: number, due: Date, kind: 'followup' | 'reminder') =>
  ({ id, kind, title: `Note ${String(id)}`, due_at: due.toISOString() }) as EaFollowup

const CHANNELS = [
  poller('Feed', 300, local(1, 10, 5)),
  reminder('Nudge', 14_400, local(1, 12)),
  reminder('Standup', 3600, local(2, 9), { cron: '0 9 * * *', timezone: ZONE }),
  poller('Resting', 600, null),
  { source: 'webhook', id: 'hook', name: 'Hook' } as ChannelInfo,
]

const lines = (channels: ChannelInfo[], hours: number, followups: EaFollowup[] = [], timezone = ZONE) =>
  buildAgenda({ channels, followups, now: NOW, hours, timezone }).days.map((day) => [
    day.label,
    ...day.entries.map(
      (entry) => `${new Date(entry.at).toTimeString().slice(0, 5)} ${entry.name} x${String(entry.runs)}`,
    ),
  ])

describe('buildAgenda', () => {
  it('lists sparse runs one by one and folds a frequent poller into one line a day', () => {
    expect(lines(CHANNELS, 24)).toEqual([
      ['Today', '10:05 Feed x167', '12:00 Nudge x1', '16:00 Nudge x1', '20:00 Nudge x1'],
      ['Tomorrow', '00:00 Feed x120', '00:00 Nudge x1', '04:00 Nudge x1', '08:00 Nudge x1', '09:00 Standup x1'],
    ])
  })

  it('names later days by their date and counts whole days of a frequent schedule', () => {
    const week = buildAgenda({ channels: CHANNELS, followups: [], now: NOW, hours: 168, timezone: ZONE })
    expect(week.days).toHaveLength(8)
    expect(week.days[2]?.label).toBe(
      local(3, 0).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
    )
    expect(week.days[2]?.entries.find((entry) => entry.name === 'Feed')).toMatchObject({
      runs: 288,
      detail: 'Every 5 min',
    })
    expect(week.days[2]?.entries.filter((entry) => entry.name === 'Nudge')).toHaveLength(6)
  })

  it.each([
    { clock: '12:00', now: local(1, 12), rows: 8 },
    { clock: '23:20', now: local(1, 23, 20), rows: 8 },
    { clock: '23:30', now: local(1, 23, 30), rows: 12 },
    { clock: '23:58', now: local(1, 23, 58), rows: 7 },
    { clock: '00:00', now: local(2, 0), rows: 7 },
    { clock: '00:10', now: local(2, 0, 10), rows: 9 },
    { clock: '00:40', now: local(2, 0, 40), rows: 8 },
  ])('lists a part day with few runs left one by one: a week from $clock has $rows lines', ({ now, rows }) => {
    const feed = poller('Feed', 300, new Date(now.getTime() + 300_000))
    const week = buildAgenda({ channels: [feed], followups: [], now, hours: 168, timezone: ZONE })
    expect(week.days.flatMap((day) => day.entries)).toHaveLength(rows)
  })

  it('leaves paused channels out with their names, and webhooks out altogether', () => {
    const agenda = buildAgenda({ channels: CHANNELS, followups: [], now: NOW, hours: 24, timezone: ZONE })
    expect(agenda.paused).toEqual([{ id: 'Resting', name: 'Resting', kind: 'poller' }])
    expect(agenda.days.flatMap((day) => day.entries).some((entry) => entry.name === 'Hook')).toBe(false)
  })

  it('names the timezone of a cron schedule read in another one than the viewer', () => {
    const detailOf = (timezone: string) =>
      buildAgenda({ channels: CHANNELS, followups: [], now: NOW, hours: 24, timezone })
        .days.flatMap((day) => day.entries)
        .find((entry) => entry.name === 'Standup')?.detail
    expect(detailOf(ZONE)).toBe('At 09:00')
    expect(detailOf('Mars/Olympus')).toBe(`At 09:00 (${ZONE} time)`)
  })

  it('shows the EA follow-ups due in the range, an overdue one today', () => {
    const followups = [
      followup(1, local(1, 9, 30), 'followup'),
      followup(2, local(1, 15), 'reminder'),
      followup(3, local(4, 9), 'followup'),
    ]
    expect(lines([], 24, followups)).toEqual([['Today', '09:30 Note 1 x1', '15:00 Note 2 x1']])
    expect(
      buildAgenda({ channels: [], followups, now: NOW, hours: 24, timezone: ZONE }).days[0]?.entries[1],
    ).toMatchObject({
      kind: 'followup',
      id: '2',
      detail: 'The EA reminds you',
    })
  })

  it('has no days when nothing runs in the range', () => {
    expect(lines([reminder('Monthly', 3600, local(20, 9), { cron: '0 9 20 * *', timezone: ZONE })], 24)).toEqual([])
  })

  it('carries when the subscribed agents get what a channel reports, each choice once', () => {
    const sub = (
      delivery: DeliveryTiming | null,
      target: ChannelTarget = 'task',
      archived = false,
    ): ChannelSubscription => ({
      id: 1,
      channel_id: 'Feed',
      channel_name: 'Feed',
      preset: 'poller',
      target,
      task_id: target === 'task' ? 'task' : null,
      task_title: null,
      task_archived: archived,
      events: null,
      mode: 'report',
      delivery,
      created_at: NOW.toISOString(),
    })
    const feed: ChannelInfo = {
      ...poller('Feed', 14_400, local(1, 12)),
      subscriptions: [sub(null, 'ea'), sub('now'), sub('now'), sub(null), sub('with_message', 'task', true)],
    }
    const agenda = buildAgenda({ channels: [feed], followups: [], now: NOW, hours: 4, timezone: ZONE })
    expect(agenda.days[0]?.entries.map((entry) => entry.deliveries)).toEqual([['now', null]])
  })
})
