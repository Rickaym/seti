import {
  nextRunTimes,
  previousRunTime,
  REMINDER_LIMITS,
  type CronSchedule,
  type ReminderChange,
  type ReminderRun,
  type ReminderRunOutcome,
  type ReminderSettings,
} from '@seti/shared'
import { sql, transaction } from '../db.js'
import { historyStart } from './pollers.js'

/** A reminder channel with its settings and where its runs stand. */
export interface ReminderRecord extends ReminderSettings {
  id: string
  name: string
  created_at: string
  updated_at: string
  /** The JSON the script keeps between runs; null before it keeps any. */
  state: unknown
  last_output: string | null
  failures: number
  /** Whether subscribers were told it is failing, so they hear once when it recovers. */
  failing: boolean
  last_run_at: string | null
  last_ok_at: string | null
  next_run_at: string | null
}

type Row = Omit<ReminderRecord, 'state' | 'schedule'> & {
  state: string | null
  cron: string | null
  timezone: string | null
}

const scheduleOf = (cron: string | null, timezone: string | null): CronSchedule | null =>
  cron === null || timezone === null ? null : { cron, timezone }

const toRecord = ({ cron, timezone, ...row }: Row): ReminderRecord => ({
  ...row,
  schedule: scheduleOf(cron, timezone),
  state: row.state === null ? null : (JSON.parse(row.state) as unknown),
})

const SELECT = sql`SELECT c.id, c.name, c.created_at, c.updated_at, r.script, r.interval_s, r.cron, r.timezone,
    r.enabled, r.state, r.last_output, r.failures, r.failing, r.last_run_at, r.last_ok_at, r.next_run_at
  FROM channel c JOIN channel_reminder r ON r.channel_id = c.id`

type RunRow = Omit<ReminderRun, 'logs'> & { logs: string }

const strings = (text: string): string[] => {
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
}

const toRun = (row: RunRow): ReminderRun => ({ ...row, logs: strings(row.logs) })

/** The ISO time `seconds` after `at`, as every stored time is written. */
export const after = (at: string, seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString()

/** The first run after `at`: the next cron slot, or one interval on. */
function nextRunAfter(timing: Pick<ReminderSettings, 'interval_s' | 'schedule'>, at: string): string | null {
  const { schedule } = timing
  return schedule === null
    ? after(at, timing.interval_s)
    : (nextRunTimes(schedule.cron, schedule.timezone, 1, new Date(at))[0] ?? null)
}

/** A cron slot missed while Seti was down still runs when it was at most this long ago. */
const CRON_CATCH_UP_MS = 60 * 60_000

export type NewReminderRun = Omit<ReminderRun, 'id'>

/** A reminder a tick took, with the time it was due. */
export interface ClaimedReminder {
  id: string
  due_at: string
}

/** What a finished run leaves behind; state undefined keeps the stored state. */
export interface RunEnd {
  at: string
  outcome: ReminderRunOutcome
  message: string | null
  state: unknown
}

/**
 * Claims due cron reminders and moves each to its first slot after `at`. The newest slot missed
 * while Seti was down runs once when at most CRON_CATCH_UP_MS old; older ones are skipped.
 */
async function claimCron(at: string, limit: number): Promise<ClaimedReminder[]> {
  return transaction(async (tx) => {
    const due = await tx<{ id: string; next_run_at: string; cron: string; timezone: string }[]>`SELECT
        channel_id AS id, next_run_at, cron, timezone FROM channel_reminder
      WHERE enabled AND cron IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ${at}
      ORDER BY next_run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`
    const claimed: ClaimedReminder[] = []
    for (const row of due) {
      const next = nextRunTimes(row.cron, row.timezone, 1, new Date(at))[0] ?? null
      await tx`UPDATE channel_reminder SET next_run_at = ${next} WHERE channel_id = ${row.id}`
      const slot = previousRunTime(row.cron, row.timezone, new Date(at))
      if (slot !== null && slot >= row.next_run_at && Date.parse(at) - Date.parse(slot) <= CRON_CATCH_UP_MS) {
        claimed.push({ id: row.id, due_at: slot })
      }
    }
    return claimed
  })
}

/** Reminder channels and their runs. */
export const reminderStore = {
  list: async (): Promise<ReminderRecord[]> => (await sql<Row[]>`${SELECT} ORDER BY c.created_at, c.id`).map(toRecord),
  get: async (id: string): Promise<ReminderRecord | undefined> => {
    const [row] = await sql<Row[]>`${SELECT} WHERE c.id = ${id}`
    return row && toRecord(row)
  },
  create: async (id: string, name: string, settings: ReminderSettings, at: string): Promise<ReminderRecord> => {
    const next = settings.enabled ? nextRunAfter(settings, at) : null
    const { schedule } = settings
    await transaction(async (tx) => {
      await tx`INSERT INTO channel (id, name, preset, secret, mapping, created_at, updated_at, source)
        VALUES (${id}, ${name}, 'reminder', NULL, '{}', ${at}, ${at}, 'reminder')`
      await tx`INSERT INTO channel_reminder (channel_id, script, interval_s, cron, timezone, enabled, next_run_at)
        VALUES (${id}, ${settings.script}, ${settings.interval_s}, ${schedule?.cron ?? null},
          ${schedule?.timezone ?? null}, ${settings.enabled}, ${next})`
    })
    const created = await reminderStore.get(id)
    if (created === undefined) {
      throw new Error('Reminder was not created')
    }
    return created
  },
  /** Applies a change; new timing or a resume times the next run from `at`, a pause clears it. */
  update: async (id: string, change: ReminderChange, at: string): Promise<ReminderRecord | undefined> => {
    const { schedule } = change
    const retimed = change.interval_s !== undefined || schedule !== undefined || change.enabled !== undefined
    await transaction(async (tx) => {
      await tx`UPDATE channel SET name = COALESCE(${change.name ?? null}, name), updated_at = ${at}
        WHERE id = ${id} AND source = 'reminder'`
      const [row] = await tx<Pick<Row, 'interval_s' | 'cron' | 'timezone' | 'enabled'>[]>`UPDATE channel_reminder
        SET script = COALESCE(${change.script ?? null}, script),
          interval_s = COALESCE(${change.interval_s ?? null}::integer, interval_s),
          cron = CASE WHEN ${schedule !== undefined} THEN ${schedule?.cron ?? null} ELSE cron END,
          timezone = CASE WHEN ${schedule !== undefined} THEN ${schedule?.timezone ?? null} ELSE timezone END,
          enabled = COALESCE(${change.enabled ?? null}::boolean, enabled)
        WHERE channel_id = ${id} RETURNING interval_s, cron, timezone, enabled`
      if (row !== undefined && retimed) {
        const timing = { interval_s: row.interval_s, schedule: scheduleOf(row.cron, row.timezone) }
        const next = row.enabled ? nextRunAfter(timing, at) : null
        await tx`UPDATE channel_reminder SET next_run_at = ${next} WHERE channel_id = ${id}`
      }
    })
    return reminderStore.get(id)
  },
  /**
   * Claims due interval reminders and moves each to its next slot after `at`, the due time plus
   * whole intervals, in one statement: none fires twice, missed slots run once, the grid holds.
   * Cron reminders are claimed the same way, but run only their newest slot within the catch-up.
   */
  claimDue: async (at: string, limit: number): Promise<ClaimedReminder[]> => [
    ...(await sql<ClaimedReminder[]>`UPDATE channel_reminder r
        SET next_run_at = to_char((due.next_run_at::timestamptz + make_interval(secs => r.interval_s
            * (floor(extract(epoch FROM ${at}::timestamptz - due.next_run_at::timestamptz) / r.interval_s) + 1)))
          AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        FROM (SELECT channel_id, next_run_at FROM channel_reminder
          WHERE enabled AND cron IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ${at}
          ORDER BY next_run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED) due
        WHERE r.channel_id = due.channel_id RETURNING r.channel_id AS id, due.next_run_at AS due_at`),
    ...(await claimCron(at, limit)),
  ],
  /** Enabled reminders with no next run, or one past by marginS, plus an interval for interval ones. */
  overdue: async (at: string, marginS: number): Promise<{ id: string; next_run_at: string | null }[]> => [
    ...(await sql<
      { id: string; next_run_at: string | null }[]
    >`SELECT channel_id AS id, next_run_at FROM channel_reminder
      WHERE enabled AND (next_run_at IS NULL OR next_run_at::timestamptz < ${at}::timestamptz
        - make_interval(secs => CASE WHEN cron IS NULL THEN interval_s ELSE 0 END + ${marginS}))
      ORDER BY channel_id`),
  ],
  /** The soonest next run of an enabled reminder, so the ticker can wake for it on time. */
  soonest: async (): Promise<string | null> => {
    const [row] = await sql<{ at: string | null }[]>`SELECT min(next_run_at) AS at FROM channel_reminder WHERE enabled`
    return row?.at ?? null
  },
  /** Makes these reminders due by `at`, so the next tick claims them; a cron one keeps its slot. */
  rearm: async (ids: readonly string[], at: string): Promise<void> => {
    if (ids.length > 0) {
      await sql`UPDATE channel_reminder SET next_run_at = CASE WHEN cron IS NULL OR next_run_at IS NULL
          THEN ${at} ELSE next_run_at END
        WHERE enabled AND channel_id IN ${sql([...ids])}`
    }
  },
  /** Records how a run ended; says how many failed in a row and whether it now fails or recovered. */
  finished: async (id: string, end: RunEnd): Promise<{ failures: number; nowFailing: boolean; recovered: boolean }> => {
    const ok = end.outcome === 'ok' || end.outcome === 'empty'
    const state = end.state === undefined ? null : JSON.stringify(end.state)
    const [row] = await sql<{ failures: number; failing: boolean; was: boolean }[]>`UPDATE channel_reminder r
      SET last_run_at = ${end.at},
        last_ok_at = CASE WHEN ${ok} THEN ${end.at} ELSE r.last_ok_at END,
        last_output = CASE WHEN ${end.outcome === 'ok'} THEN ${end.message} ELSE r.last_output END,
        state = CASE WHEN ${ok} THEN COALESCE(${state}, r.state) ELSE r.state END,
        failures = CASE WHEN ${ok} THEN 0 ELSE r.failures + 1 END,
        failing = CASE WHEN ${ok} THEN false
          ELSE r.failing OR r.failures + 1 >= ${REMINDER_LIMITS.failuresBeforeFailing} END
      FROM (SELECT failing AS was FROM channel_reminder WHERE channel_id = ${id}) old
      WHERE r.channel_id = ${id} RETURNING r.failures, r.failing, old.was`
    if (row === undefined) {
      return { failures: 0, nowFailing: false, recovered: false }
    }
    return { failures: row.failures, nowFailing: row.failing && !row.was, recovered: row.was && !row.failing }
  },
  addRun: async (run: NewReminderRun): Promise<ReminderRun> => {
    const [row] = await sql<RunRow[]>`INSERT INTO channel_reminder_run (channel_id, trigger, due_at, started_at,
        duration_ms, outcome, message, error, logs)
      VALUES (${run.channel_id}, ${run.trigger}, ${run.due_at}, ${run.started_at}, ${run.duration_ms},
        ${run.outcome}, ${run.message}, ${run.error}, ${JSON.stringify(run.logs)})
      RETURNING *`
    await sql`DELETE FROM channel_reminder_run WHERE channel_id = ${run.channel_id}
      AND started_at < ${historyStart(run.started_at)}`
    await sql`UPDATE channel_reminder_run SET logs = '[]' WHERE id = (
        SELECT id FROM channel_reminder_run WHERE channel_id = ${run.channel_id}
        ORDER BY id DESC OFFSET ${REMINDER_LIMITS.runsKept} LIMIT 1) AND logs <> '[]'`
    if (row === undefined) {
      throw new Error('Run was not recorded')
    }
    return toRun(row)
  },
  runs: async (id: string, limit: number): Promise<ReminderRun[]> =>
    (
      await sql<RunRow[]>`SELECT * FROM channel_reminder_run WHERE channel_id = ${id}
        ORDER BY id DESC LIMIT ${limit}`
    ).map(toRun),
}
