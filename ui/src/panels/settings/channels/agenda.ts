import { runsInRange, type ChannelInfo, type EaFollowup, type RunTiming } from '@seti/shared'
import { describeSchedule } from '@/components/schedule/cron'
import { intervalLabel } from './interval'

/** How far ahead the schedule looks. */
export const AGENDA_RANGES = [
  { id: '24h', label: '24 h', hint: 'The next 24 hours', hours: 24 },
  { id: '7d', label: '7 d', hint: 'The next 7 days', hours: 7 * 24 },
  { id: '30d', label: '30 d', hint: 'The next 30 days', hours: 30 * 24 },
] as const

export type AgendaRangeId = (typeof AGENDA_RANGES)[number]['id']

/** A channel with more runs than this in a day shows as one line with their count. */
const COLLAPSE_OVER = 6

export type AgendaKind = 'poller' | 'reminder' | 'followup'

export interface AgendaEntry {
  key: string
  /** The run's time, or the first of the day's runs for a collapsed line. */
  at: string
  kind: AgendaKind
  /** The channel's id, or the follow-up's. */
  id: string
  name: string
  /** When it runs, in words. */
  detail: string
  /** How many runs the line stands for; over one for a collapsed line. */
  runs: number
}

export interface AgendaDay {
  key: string
  label: string
  entries: AgendaEntry[]
}

interface PausedChannel {
  id: string
  name: string
  kind: AgendaKind
}

export interface Agenda {
  days: AgendaDay[]
  paused: PausedChannel[]
}

interface Scheduled {
  id: string
  name: string
  kind: 'poller' | 'reminder'
  enabled: boolean
  timing: RunTiming
  detail: string
}

function scheduledOf(info: ChannelInfo, timezone: string): Scheduled | null {
  if (info.source === 'poller') {
    const { enabled, interval_s, next_run_at } = info.poller
    const timing = { interval_s, next_run_at }
    return {
      id: info.id,
      name: info.name,
      kind: 'poller',
      enabled,
      timing,
      detail: `Every ${intervalLabel(interval_s)}`,
    }
  }
  if (info.source !== 'reminder') {
    return null
  }
  const { enabled, interval_s, schedule, next_run_at } = info.reminder
  const zone = schedule === null || schedule.timezone === timezone ? '' : ` (${schedule.timezone} time)`
  const detail = schedule === null ? `Every ${intervalLabel(interval_s)}` : `${describeSchedule(schedule.cron)}${zone}`
  return {
    id: info.id,
    name: info.name,
    kind: 'reminder',
    enabled,
    timing: { interval_s, schedule, next_run_at },
    detail,
  }
}

const dayKey = (date: Date) => `${String(date.getFullYear())}-${String(date.getMonth() + 1)}-${String(date.getDate())}`

function dayLabel(start: Date, index: number): string {
  if (index < 2) {
    return index === 0 ? 'Today' : 'Tomorrow'
  }
  return start.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

/** The viewer's days from `now` to `to`: the rest of today, whole days, then the last part day. */
function daysBetween(now: Date, to: Date): { start: Date; end: Date }[] {
  const days: { start: Date; end: Date }[] = []
  let start = now
  while (start < to) {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days.length + 1)
    const end = midnight < to ? midnight : to
    days.push({ start, end })
    start = end
  }
  return days
}

/** One channel's lines for a day: each run, or one line once there are too many to list. */
function channelEntries(channel: Scheduled, day: { start: Date; end: Date }): AgendaEntry[] {
  const range = { from: new Date(day.start.getTime() - 1), to: new Date(day.end.getTime() - 1) }
  const { count, times } = runsInRange(channel.timing, range, COLLAPSE_OVER)
  const { id, name, kind, detail } = channel
  const [first] = times
  if (count > COLLAPSE_OVER && first !== undefined) {
    return [{ key: `${id}:${first}`, at: first, kind, id, name, detail, runs: count }]
  }
  return times.map((at) => ({ key: `${id}:${at}`, at, kind, id, name, detail, runs: 1 }))
}

function followupEntries(followups: EaFollowup[], day: { start: Date; end: Date }, first: boolean): AgendaEntry[] {
  return followups
    .filter((item) => {
      const due = Date.parse(item.due_at)
      return due < day.end.getTime() && (first || due >= day.start.getTime())
    })
    .map((item) => ({
      key: `followup:${String(item.id)}`,
      at: item.due_at,
      kind: 'followup' as const,
      id: String(item.id),
      name: item.title,
      detail: item.kind === 'reminder' ? 'The EA reminds you' : 'The EA checks back',
      runs: 1,
    }))
}

/** What runs from `now` over the coming hours, by the viewer's day, and what is paused. */
export function buildAgenda(input: {
  channels: ChannelInfo[]
  followups: EaFollowup[]
  now: Date
  hours: number
  /** The viewer's timezone; a cron schedule read in another one names it. */
  timezone: string
}): Agenda {
  const { now, followups } = input
  const scheduled = input.channels.flatMap((info) => scheduledOf(info, input.timezone) ?? [])
  const running = scheduled.filter((channel) => channel.enabled)
  const to = new Date(now.getTime() + input.hours * 3_600_000)
  const days = daysBetween(now, to).map((day, index) => ({
    key: dayKey(day.start),
    label: dayLabel(day.start, index),
    entries: [
      ...running.flatMap((channel) => channelEntries(channel, day)),
      ...followupEntries(followups, day, index === 0),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
  }))
  return {
    days: days.filter((day) => day.entries.length > 0),
    paused: scheduled.filter((channel) => !channel.enabled).map(({ id, name, kind }) => ({ id, name, kind })),
  }
}
