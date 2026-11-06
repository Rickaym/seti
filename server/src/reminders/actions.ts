import type {
  ReminderChange,
  ReminderChannelInfo,
  reminderCreateInput,
  reminderTestInput,
  ReminderTestResult,
} from '@seti/shared'
import type { z } from 'zod'
import { audit } from '../audit.js'
import { reminders } from './service.js'

const CHANGE_FIELDS = ['name', 'script', 'interval_s', 'schedule', 'enabled'] as const

export async function createReminder(input: z.output<typeof reminderCreateInput>): Promise<ReminderChannelInfo> {
  const created = await reminders.create(input)
  await audit.record({
    actor: 'user',
    kind: 'system.channel_created',
    subject_type: 'system',
    subject_id: created.id,
    summary: `Created the reminder ${created.name}`,
    detail: {
      channel: created.name,
      preset: 'reminder',
      interval_s: input.interval_s,
      cron: input.schedule === null ? null : `${input.schedule.cron} (${input.schedule.timezone})`,
      subscribe_ea: input.subscribe_ea,
    },
  })
  return created
}

export async function updateReminder(id: string, change: ReminderChange): Promise<ReminderChannelInfo> {
  const before = await reminders.get(id)
  const after = await reminders.update(id, change)
  const saved = { ...after.reminder, name: after.name }
  const changed = CHANGE_FIELDS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(saved[key]))
  if (changed.length > 0) {
    await audit.record({
      actor: 'user',
      kind: 'system.channel_changed',
      subject_type: 'system',
      subject_id: id,
      summary: `Changed the reminder ${after.name}: ${changed.join(', ')}`,
      detail: { channel: after.name, changed: [...changed] },
    })
  }
  return after
}

/** Runs a script once without delivering or storing anything. */
export async function testReminder(input: z.output<typeof reminderTestInput>): Promise<ReminderTestResult> {
  return reminders.test(input)
}

export async function runReminderNow(id: string): Promise<ReminderChannelInfo> {
  const ran = await reminders.runNow(id)
  const last = ran.reminder.runs[0]
  const outcome = last === undefined ? 'no run' : (last.error ?? last.outcome)
  await audit.record({
    actor: 'user',
    kind: 'system.channel_polled',
    subject_type: 'system',
    subject_id: ran.id,
    summary: `Ran the reminder ${ran.name} now: ${outcome}`,
    detail: { channel: ran.name, outcome: last?.outcome ?? null },
  })
  return ran
}
