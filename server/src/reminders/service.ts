import {
  CHANNEL_ACTIVITY_SHOWN,
  REMINDER_LIMITS,
  type EaNoticeSeverity,
  type ReminderChannelInfo,
  type ReminderRun,
  type ReminderStatus,
  type ReminderTestResult,
  type reminderCreateInput,
  type reminderTestInput,
  type reminderUpdateInput,
} from '@seti/shared'
import type { z } from 'zod'
import { channelHealth } from '../channels/health.js'
import { clip, eventDraft, publishEvent, routedReason } from '../channels/publish.js'
import { routeEvent } from '../channels/router.js'
import { signalTasks, subscribedTasks } from '../channels/service.js'
import { newHookId } from '../channels/signature.js'
import { now } from '../db.js'
import { HttpError } from '../http.js'
import type { ReminderContext } from './protocol.js'
import { runSandboxed, type SandboxLimits, type ScriptOutcome } from './sandbox.js'
import { createReminderTicker } from './ticker.js'
import { channelSubscriptions } from '../store/channel-subscriptions.js'
import { channelStore } from '../store/channels.js'
import { reminderStore, type ReminderRecord } from '../store/reminders.js'

const TICK_MS = 10_000
const EXCERPT_MAX = 1000

const SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: REMINDER_LIMITS.timeoutMs,
  startupMs: 15_000,
  heapMb: REMINDER_LIMITS.heapMb,
  memoryMb: REMINDER_LIMITS.memoryMb,
  outputBytes: 256 * 1024,
  messageMaxChars: REMINDER_LIMITS.messageMaxChars,
  stateMaxBytes: REMINDER_LIMITS.stateMaxBytes,
  logLines: REMINDER_LIMITS.logLines,
  logLineChars: REMINDER_LIMITS.logLineChars,
  errorChars: 500,
}

const runScript = async (script: string, input: ReminderContext) => runSandboxed(script, input, SANDBOX_LIMITS)

function statusOf(record: ReminderRecord): ReminderStatus {
  if (!record.enabled) {
    return 'paused'
  }
  if (record.failing) {
    return 'failing'
  }
  if (record.failures > 0) {
    return 'erroring'
  }
  return record.last_ok_at === null ? 'pending' : 'ok'
}

async function info(record: ReminderRecord): Promise<ReminderChannelInfo> {
  const { id, name, created_at, updated_at } = record
  return {
    source: 'reminder',
    preset: 'reminder',
    id,
    name,
    created_at,
    updated_at,
    reminder: {
      script: record.script,
      interval_s: record.interval_s,
      schedule: record.schedule,
      enabled: record.enabled,
      status: statusOf(record),
      failures: record.failures,
      last_run_at: record.last_run_at,
      next_run_at: record.enabled ? record.next_run_at : null,
      last_output: record.last_output,
      runs: await reminderStore.runs(id, CHANNEL_ACTIVITY_SHOWN),
      health: await channelHealth({ source: 'reminder', ...record }),
    },
    subscriptions: await channelSubscriptions.forChannel(id),
    recent: await channelStore.recent(id, CHANNEL_ACTIVITY_SHOWN),
    deliveries: await channelStore.deliveries(id, CHANNEL_ACTIVITY_SHOWN),
  }
}

async function recordOf(id: string): Promise<ReminderRecord> {
  const record = await reminderStore.get(id)
  if (record === undefined) {
    throw new HttpError(404, 'No such reminder')
  }
  return record
}

interface Emitted {
  title: string
  detail: string
  kind: string
  severity: EaNoticeSeverity
}

/** Stores one event and routes it like any channel's, with a delivery log entry. */
async function emit(record: ReminderRecord, event: Emitted, key: string, at: string): Promise<void> {
  const draft = eventDraft({ source: record.name, occurred_at: at, url: null, ...event }, `${key}:${at}`)
  const { accepted, routes } = await publishEvent(record.id, draft, { at, route: routeEvent })
  if (accepted.kind !== 'event') {
    return
  }
  await channelStore.delivered({
    channel: record.id,
    received_at: at,
    status: 'accepted',
    http_status: 0,
    reason: routedReason(routes),
    delivery_id: clip(`${key}:${at}`, 200),
    event_id: accepted.event.id,
    excerpt: clip(`${event.title}\n${event.detail}`.trim(), EXCERPT_MAX),
    routes,
  })
}

/** A message as an event: its first line is the title, the rest the detail. */
function messageEvent(message: string): Emitted {
  const [first = '', ...rest] = message.split('\n')
  return {
    title: first.trim() === '' ? message.trim() : first.trim(),
    detail: rest.join('\n').trim(),
    kind: 'reminder',
    severity: 'info',
  }
}

const contextOf = (record: Pick<ReminderRecord, 'last_run_at' | 'last_output' | 'state'> | undefined, at: string) => ({
  now: at,
  lastRunAt: record?.last_run_at ?? null,
  lastOutput: record?.last_output ?? null,
  state: record?.state ?? null,
})

const errorOf = (outcome: ScriptOutcome) => ('error' in outcome ? outcome.error : null)
const messageOf = (outcome: ScriptOutcome) => ('message' in outcome ? outcome.message : null)

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Delivers a run's message; a delivery that throws turns the run into a failed one. */
async function delivered(record: ReminderRecord, result: ScriptOutcome, at: string): Promise<ScriptOutcome> {
  const message = messageOf(result)
  if (result.outcome !== 'ok' || message === null) {
    return result
  }
  try {
    await emit(record, messageEvent(message), 'reminder', at)
    return result
  } catch (e) {
    const error = `Seti could not deliver the message: ${describe(e)}`
    return { outcome: 'error', error, logs: result.logs, duration_ms: result.duration_ms }
  }
}

/** Tells subscribers of a change in health; a failure to tell is logged, never the run's. */
async function notice(record: ReminderRecord, event: Emitted, at: string): Promise<void> {
  await emit(record, event, event.kind, at).catch((e: unknown) => {
    process.stderr.write(`reminders: could not tell that ${record.name} changed health: ${describe(e)}\n`)
  })
}

/** Runs a reminder once: delivers its message, records the run, tells of failing and recovering. */
export async function runReminder(
  id: string,
  trigger: ReminderRun['trigger'],
  dueAt: string | null = null,
): Promise<void> {
  const record = await reminderStore.get(id)
  if (record === undefined) {
    return
  }
  const at = now()
  const script = await runScript(record.script, contextOf(record, at))
  if ('interrupted' in script) {
    if (dueAt !== null) {
      await reminderStore.rearm([id], dueAt)
    }
    return
  }
  const result = await delivered(record, script, at)
  const message = messageOf(result)
  const state = 'state' in result ? result.state : undefined
  const { failures, nowFailing, recovered } = await reminderStore.finished(id, {
    at,
    outcome: result.outcome,
    message,
    state,
  })
  await reminderStore.addRun({
    channel_id: id,
    trigger,
    due_at: dueAt,
    started_at: at,
    duration_ms: result.duration_ms,
    outcome: result.outcome,
    message,
    error: errorOf(result),
    logs: result.logs,
  })
  if (nowFailing) {
    const detail = `Its last ${String(failures)} runs failed. The latest: ${errorOf(result) ?? 'unknown error'}`
    const title = `${record.name} is failing`
    await notice(record, { title, detail, kind: 'reminder_failed', severity: 'warning' }, at)
  }
  if (recovered) {
    const detail = `A run worked after ${String(record.failures)} failed ones.`
    const title = `${record.name} works again`
    await notice(record, { title, detail, kind: 'reminder_recovered', severity: 'success' }, at)
  }
}

export const reminderTicker = createReminderTicker({
  claimDue: reminderStore.claimDue,
  overdue: reminderStore.overdue,
  rearm: reminderStore.rearm,
  soonest: reminderStore.soonest,
  run: runReminder,
  concurrency: REMINDER_LIMITS.concurrentRuns,
  tickMs: TICK_MS,
  onError: (e) => {
    process.stderr.write(`reminders: ${describe(e)}\n`)
  },
  onStale: (reason) => {
    process.stderr.write(`reminders: ${reason}\n`)
  },
})

/** Reminder channels: create, change, pause, delete, run now and test run them. */
export const reminders = {
  list: async (): Promise<ReminderChannelInfo[]> =>
    Promise.all((await reminderStore.list()).map(async (record) => info(record))),
  get: recordOf,
  info: async (id: string): Promise<ReminderChannelInfo> => info(await recordOf(id)),
  runs: async (id: string, limit: number): Promise<ReminderRun[]> => reminderStore.runs((await recordOf(id)).id, limit),
  create: async (input: z.output<typeof reminderCreateInput>): Promise<ReminderChannelInfo> => {
    const { name, subscribe_ea: subscribeEa, ...settings } = input
    const record = await reminderStore.create(newHookId(), name, settings, now())
    if (subscribeEa) {
      await channelSubscriptions.add({
        channel_id: record.id,
        target: 'ea',
        task_id: null,
        events: null,
        created_at: now(),
      })
    }
    return info(record)
  },
  update: async (id: string, change: z.output<typeof reminderUpdateInput>): Promise<ReminderChannelInfo> => {
    const current = await recordOf(id)
    const updated = (await reminderStore.update(id, change, now())) ?? current
    if (updated.name !== current.name) {
      signalTasks(await subscribedTasks(id))
    }
    return info(updated)
  },
  remove: async (id: string): Promise<ReminderRecord> => {
    const current = await recordOf(id)
    const taskIds = await subscribedTasks(id)
    await channelStore.remove(id)
    signalTasks(taskIds)
    return current
  },
  runNow: async (id: string): Promise<ReminderChannelInfo> => {
    await recordOf(id)
    if (!(await reminderTicker.runNow(id))) {
      throw new HttpError(409, 'This reminder is running already')
    }
    return info(await recordOf(id))
  },
  /** Runs a script once with a saved reminder's last run if named; delivers and stores nothing. */
  test: async (input: z.output<typeof reminderTestInput>): Promise<ReminderTestResult> => {
    const saved = input.channel_id === undefined ? undefined : await recordOf(input.channel_id)
    const result = await reminderTicker.withSlot(async () => runScript(input.script, contextOf(saved, now())))
    const kept = 'state' in result ? result.state : (saved?.state ?? null)
    return {
      outcome: result.outcome,
      message: messageOf(result),
      error: errorOf(result),
      logs: result.logs,
      duration_ms: result.duration_ms,
      state: kept,
    }
  },
}
