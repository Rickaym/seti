import type { ChannelInfo, PollerChannelInfo, ReminderChannelInfo } from '@seti/shared'

type Scheduled = PollerChannelInfo | ReminderChannelInfo

const RUNS_SHOWN = 30

const isScheduled = (info: ChannelInfo): info is Scheduled => info.source === 'poller' || info.source === 'reminder'

const timingOf = (info: Scheduled) => (info.source === 'poller' ? info.poller : info.reminder)

/** When it runs: its cron schedule with the timezone, or its interval. */
function timingText(info: Scheduled): string {
  const schedule = info.source === 'reminder' ? info.reminder.schedule : null
  return schedule === null
    ? `every ${String(timingOf(info).interval_s)} s`
    : `cron ${schedule.cron} (${schedule.timezone})`
}

/** What pollers and reminders run next, soonest first, and which are paused. */
export function upcomingView(channels: ChannelInfo[]) {
  const scheduled = channels.filter(isScheduled)
  const runs = scheduled
    .flatMap((info) =>
      timingOf(info).upcoming.map((at) => ({ at, channel: info.name, source: info.source, runs: timingText(info) })),
    )
    .sort((a, b) => a.at.localeCompare(b.at))
  return {
    next_runs: runs.slice(0, RUNS_SHOWN),
    paused: scheduled.filter((info) => !timingOf(info).enabled).map((info) => info.name),
  }
}
