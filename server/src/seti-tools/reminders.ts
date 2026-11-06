import {
  reminderCreateInput,
  reminderTestInput,
  REMINDER_API_DOC,
  REMINDER_LIMITS,
  type CronSchedule,
  type ReminderChannelInfo,
  type ReminderRun,
} from '@seti/shared'
import { z } from 'zod'
import { subscriberView } from './channel-refs.js'
import { setiTool, ToolRefusal } from './tool.js'
import { createReminder, testReminder } from '../reminders/actions.js'

const MINUTE_S = 60

export const reminderScript = z.string().min(1).describe(REMINDER_API_DOC)

export const reminderMinutes = z
  .number()
  .int()
  .min(REMINDER_LIMITS.intervalMinS / MINUTE_S)
  .max(REMINDER_LIMITS.intervalMaxS / MINUTE_S)
  .optional()
  .describe('Reminders only: minutes between runs, 1 to 10080; default 60.')

export const reminderCron = z
  .string()
  .trim()
  .optional()
  .describe(
    "Reminders only: a 5-field cron schedule such as '0 9 * * 1' (Mondays 09:00) that replaces the " +
      'interval; an empty string goes back to the interval.',
  )

export const reminderTimezone = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("The IANA timezone the cron schedule reads in, such as Europe/Berlin; default the reminder's, else UTC.")

/** The schedule tool arguments ask for: undefined keeps it, null goes back to the interval. */
function scheduleFrom(
  current: CronSchedule | null,
  args: { cron?: string | undefined; timezone?: string | undefined },
): CronSchedule | null | undefined {
  if (args.cron === undefined && args.timezone === undefined) {
    return undefined
  }
  if (args.cron === '') {
    return null
  }
  const cron = args.cron ?? current?.cron
  if (cron === undefined) {
    throw new ToolRefusal('Give a cron schedule with the timezone.')
  }
  return { cron, timezone: args.timezone ?? current?.timezone ?? 'UTC' }
}

export const reminderRunView = ({ trigger, started_at, duration_ms, outcome, message, error, logs }: ReminderRun) => ({
  trigger,
  started_at,
  duration_ms,
  outcome,
  ...(message === null ? {} : { message }),
  ...(error === null ? {} : { error }),
  ...(logs.length === 0 ? {} : { logs: logs.slice(0, 5) }),
})

/** A reminder as an agent needs it: its schedule, script, subscribers and latest runs. */
export const reminderView = (info: ReminderChannelInfo, withScript = true) => {
  const { reminder } = info
  return {
    id: info.id,
    name: info.name,
    source: info.source,
    status: reminder.status,
    enabled: reminder.enabled,
    interval_s: reminder.interval_s,
    schedule: reminder.schedule,
    failures: reminder.failures,
    last_run_at: reminder.last_run_at,
    next_run_at: reminder.next_run_at,
    last_output: reminder.last_output,
    subscribers: info.subscriptions.map(subscriberView),
    ...(withScript ? { script: reminder.script } : {}),
    latest_runs: reminder.runs.slice(0, withScript ? 3 : 1).map(reminderRunView),
  }
}

/** A reminder change from tool arguments: active pauses or resumes; minutes or cron set timing. */
export function reminderChange(
  info: ReminderChannelInfo,
  args: {
    name?: string | undefined
    script?: string | undefined
    minutes?: number | undefined
    cron?: string | undefined
    timezone?: string | undefined
    active?: boolean | undefined
  },
) {
  const { reminder } = info
  const interval = args.minutes === undefined ? undefined : args.minutes * MINUTE_S
  const schedule = scheduleFrom(reminder.schedule, args)
  const sameSchedule = schedule === undefined || JSON.stringify(schedule) === JSON.stringify(reminder.schedule)
  return {
    ...(sameSchedule ? {} : { schedule }),
    ...(args.name === undefined || args.name === info.name ? {} : { name: args.name }),
    ...(args.script === undefined || args.script === reminder.script ? {} : { script: args.script }),
    ...(interval === undefined || interval === reminder.interval_s ? {} : { interval_s: interval }),
    ...(args.active === undefined || args.active === reminder.enabled ? {} : { enabled: args.active }),
  }
}

/** A test run of a reminder script: a draft, a saved reminder, or a new script for a saved one. */
export async function testReminderScript(draft: string | undefined, saved: ReminderChannelInfo | null) {
  const script = draft ?? saved?.reminder.script
  if (script === undefined) {
    throw new ToolRefusal('Give a script to test, or a reminder.')
  }
  return testReminder(reminderTestInput.parse({ script, ...(saved === null ? {} : { channel_id: saved.id }) }))
}

const createReminderTool = setiTool({
  name: 'create_reminder',
  description:
    'Create a reminder: a channel whose script Seti runs on an interval or a cron schedule, without a model, in a locked-down ' +
    'process. Each message it returns reaches its subscribers like any channel event. Try the script with ' +
    'test_channel_script first; subscribe agents with subscribe_channel; change or pause it with update_channel.',
  input: {
    name: reminderCreateInput.shape.name,
    script: reminderScript,
    interval_minutes: reminderMinutes,
    cron: reminderCron,
    timezone: reminderTimezone,
    subscribe_ea: reminderCreateInput.shape.subscribe_ea.describe("Also send its messages to the EA's inbox."),
  },
  run: async (args) => {
    const input = reminderCreateInput.parse({
      name: args.name,
      script: args.script,
      subscribe_ea: args.subscribe_ea,
      ...(args.interval_minutes === undefined ? {} : { interval_s: args.interval_minutes * MINUTE_S }),
      schedule: scheduleFrom(null, args) ?? null,
    })
    return reminderView(await createReminder(input))
  },
})

export const REMINDER_TOOLS = [createReminderTool]
