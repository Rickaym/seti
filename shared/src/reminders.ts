import { z } from 'zod'
import type { ChannelHealth } from './channel-health.js'
import { cronSchedule } from './cron.js'

/** Limits every reminder runs under; the editor's help quotes them. */
export const REMINDER_LIMITS = {
  intervalMinS: 60,
  intervalDefaultS: 3600,
  intervalMaxS: 7 * 86_400,
  /** How long the script may take, from loading it to its answer. */
  timeoutMs: 5000,
  /** The V8 heap of the script's process. */
  heapMb: 64,
  /** The resident memory of the script's process, buffers included. */
  memoryMb: 256,
  messageMaxChars: 2000,
  stateMaxBytes: 16 * 1024,
  scriptMaxChars: 20_000,
  logLines: 20,
  logLineChars: 300,
  failuresBeforeFailing: 3,
  concurrentRuns: 2,
  runsKept: 50,
} as const

export const REMINDER_TEMPLATE = `export default function remind({ now, lastRunAt, lastOutput, state }) {
  const day = new Date(now).getUTCDay()
  if (day === 0 || day === 6) {
    return null
  }
  return 'Check the open pull requests and say which ones wait on you.'
}
`

/** The script contract, as the editor and the tools describe it. */
export const REMINDER_API_DOC = [
  'export default async function remind({ now, lastRunAt, lastOutput, state })',
  'Return a string to deliver to the subscribers, or null or an empty string to skip this run.',
  'Return { message, state } to also keep a small JSON state for the next run.',
  'A script may instead end with a top-level return of that function.',
  '',
  'now and lastRunAt are ISO times; lastOutput is the last message delivered, or null.',
  'console.log lines show in the run log.',
  '',
  'Reminders run in a separate Node process with no files, network, processes or environment,',
  `and stop after ${String(REMINDER_LIMITS.timeoutMs / 1000)} s.`,
].join('\n')

/** A reminder's own event kinds: its message, and its failing and recovering. */
export const REMINDER_EVENT_KINDS = ['reminder', 'reminder_failed', 'reminder_recovered'] as const

const reminderFields = {
  name: z.string().trim().min(1).max(80),
  script: z
    .string()
    .max(REMINDER_LIMITS.scriptMaxChars)
    .refine((script) => script.trim() !== '', 'Write the reminder function'),
  interval_s: z.number().int().min(REMINDER_LIMITS.intervalMinS).max(REMINDER_LIMITS.intervalMaxS),
  /** A cron schedule replaces the interval while it is set; null runs every interval_s. */
  schedule: cronSchedule.nullable(),
  enabled: z.boolean(),
}

/** What runs a reminder: its script, when, and whether it is on. */
export const reminderSettingsInput = z.object({
  script: reminderFields.script,
  interval_s: reminderFields.interval_s.default(REMINDER_LIMITS.intervalDefaultS),
  schedule: reminderFields.schedule.default(null),
  enabled: reminderFields.enabled.default(true),
})
export type ReminderSettings = z.output<typeof reminderSettingsInput>

export const reminderCreateInput = reminderSettingsInput.extend({
  name: reminderFields.name,
  subscribe_ea: z.boolean().default(false),
})
export type ReminderCreateInput = z.input<typeof reminderCreateInput>

export const reminderUpdateInput = z
  .object({
    name: reminderFields.name.optional(),
    script: reminderFields.script.optional(),
    interval_s: reminderFields.interval_s.optional(),
    schedule: reminderFields.schedule.optional(),
    enabled: reminderFields.enabled.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), 'Change at least one field')
export type ReminderUpdateInput = z.input<typeof reminderUpdateInput>
export type ReminderChange = z.output<typeof reminderUpdateInput>

/** A test run takes the script as edited; a saved reminder's id gives it that reminder's last run. */
export const reminderTestInput = z.object({
  script: reminderFields.script,
  channel_id: z.string().max(100).optional(),
})
export type ReminderTestInput = z.input<typeof reminderTestInput>

/** ok: it returned a message; empty: it had nothing to say this time. */
export type ReminderRunOutcome = 'ok' | 'empty' | 'error' | 'timeout'

export interface ReminderRun {
  id: number
  channel_id: string
  trigger: 'schedule' | 'manual'
  /** When the schedule wanted the run; null for a run on request and runs from before Seti kept it. */
  due_at: string | null
  started_at: string
  duration_ms: number
  outcome: ReminderRunOutcome
  message: string | null
  error: string | null
  logs: string[]
}

export type ReminderStatus = 'pending' | 'ok' | 'erroring' | 'failing' | 'paused'

export interface ReminderInfo extends ReminderSettings {
  status: ReminderStatus
  failures: number
  last_run_at: string | null
  next_run_at: string | null
  last_output: string | null
  runs: ReminderRun[]
  health: ChannelHealth
}

/** A test run's answer; nothing is delivered or stored. */
export interface ReminderTestResult {
  outcome: ReminderRunOutcome
  message: string | null
  error: string | null
  logs: string[]
  duration_ms: number
  /** The state the next run would get. */
  state: unknown
}
