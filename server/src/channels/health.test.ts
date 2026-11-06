import { CHANNEL_RUN_HISTORY_DAYS, POLLER_LIMITS, type PollerRun, type ReminderRun } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { sql } from '../db.js'
import { channelHealth, channelsSummary, onTimeToleranceS } from './health.js'
import { pollerStore } from '../store/pollers.js'
import { reminderStore } from '../store/reminders.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-health-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

afterAll(async () => {
  const fs = await import('node:fs')
  fs.rmSync(scratch, { recursive: true, force: true })
})

const CREATED = '2026-10-20T00:00:00.000Z'
const NOW = Date.parse('2026-10-20T00:10:00.000Z')

async function newPoller(id: string, intervalS = 60) {
  return pollerStore.create(
    id,
    id,
    {
      script: 'export default () => []',
      preset: 'blank',
      interval_s: intervalS,
      timeout_s: 30,
      extra_hosts: [],
      secrets: [],
      fingerprint_fields: [],
      detect_gone: false,
      enabled: true,
    },
    CREATED,
  )
}

const at = (time: string) => `2026-10-20T${time}.000Z`

function run(
  id: string,
  started: string,
  extra: Partial<Omit<PollerRun, 'id' | 'channel_id'>> = {},
): Omit<PollerRun, 'id'> {
  return {
    channel_id: id,
    trigger: 'schedule',
    due_at: null,
    started_at: at(started),
    duration_ms: 100,
    ok: true,
    items: 0,
    emitted: 0,
    invalid: [],
    error: null,
    logs: [],
    ...extra,
  }
}

describe('channel health', () => {
  it('counts on-time, late, missed and failed runs over its windows', async () => {
    const poller = await newPoller('health-a')
    const runs = [
      run(poller.id, '00:01:01', { due_at: at('00:01:00'), duration_ms: 100 }),
      run(poller.id, '00:02:01', { due_at: at('00:02:00'), duration_ms: 200 }),
      run(poller.id, '00:03:01', { due_at: at('00:03:00'), duration_ms: 300, ok: false, error: 'timeout' }),
      run(poller.id, '00:04:20', { due_at: at('00:04:00'), duration_ms: 400 }),
      run(poller.id, '00:07:00', { due_at: at('00:07:00'), duration_ms: 500 }),
      run(poller.id, '00:08:00', { trigger: 'manual', duration_ms: 600, ok: false, error: 'timeout' }),
    ]
    for (const entry of runs) {
      await pollerStore.addRun(entry)
    }
    const health = await channelHealth({ source: 'poller', ...poller, next_run_at: at('00:09:00') }, NOW)
    expect(health).toMatchObject({ stale: false, overdue_s: 60 })
    expect(health.windows.map((window) => window.days)).toEqual([7, 30])
    expect(health.windows[0]).toEqual({
      days: 7,
      runs: 5,
      expected: 10,
      ok_pct: 66.7,
      on_time_pct: 80,
      late_p50_ms: 1000,
      late_p95_ms: 16_200,
      late_max_ms: 20_000,
      missed: 2,
      longest_gap_s: 160,
      duration_p95_ms: 575,
      errors: [{ error: 'timeout', count: 2 }],
    })
  })

  it('is stale when enabled with no next run or one over an interval and a minute past', async () => {
    const poller = await newPoller('health-b')
    const subject = { source: 'poller' as const, ...poller }
    expect((await channelHealth({ ...subject, next_run_at: at('00:07:59') }, NOW)).stale).toBe(true)
    expect((await channelHealth({ ...subject, next_run_at: at('00:08:00') }, NOW)).stale).toBe(false)
    expect((await channelHealth({ ...subject, next_run_at: null }, NOW)).stale).toBe(true)
    const paused = await channelHealth({ ...subject, enabled: false, next_run_at: null }, NOW)
    expect(paused).toMatchObject({ stale: false, overdue_s: null })
    expect(paused.windows[0]).toMatchObject({ runs: 0, expected: null, ok_pct: null, on_time_pct: null })
  })

  it('expects a cron reminder to run on each slot and counts the slots without a run as missed', async () => {
    const schedule = { cron: '*/2 * * * *', timezone: 'UTC' }
    const settings = { script: 'export default () => null', interval_s: 3600, schedule, enabled: true }
    const reminder = await reminderStore.create('health-cron', 'Cron', settings, CREATED)
    const reminderRun = (started: string, extra: Partial<ReminderRun> = {}): Omit<ReminderRun, 'id'> => ({
      channel_id: reminder.id,
      trigger: 'schedule',
      due_at: null,
      started_at: at(started),
      duration_ms: 100,
      outcome: 'ok',
      message: null,
      error: null,
      logs: [],
      ...extra,
    })
    for (const entry of [
      reminderRun('00:02:30', { due_at: at('00:02:00') }),
      reminderRun('00:05:30', { due_at: at('00:04:00') }),
      reminderRun('00:08:01', { due_at: at('00:08:00') }),
      reminderRun('00:09:00', { trigger: 'manual' }),
    ]) {
      await reminderStore.addRun(entry)
    }
    const subject = { source: 'reminder' as const, ...reminder }
    const health = await channelHealth({ ...subject, next_run_at: at('00:09:00') }, NOW)
    expect(health).toMatchObject({ stale: false, overdue_s: 60 })
    expect(health.windows[0]).toMatchObject({ runs: 3, expected: 5, missed: 2, on_time_pct: 66.7 })
    expect((await channelHealth({ ...subject, next_run_at: at('00:08:59') }, NOW)).stale).toBe(true)
    const onInterval = { ...subject, schedule: null, next_run_at: at('00:08:59') }
    expect((await channelHealth(onInterval, NOW)).stale).toBe(false)
  })

  it('allows a tenth of the interval to count as on time, from 5 s to a minute', () => {
    expect(onTimeToleranceS(60)).toBe(6)
    expect(onTimeToleranceS(30)).toBe(5)
    expect(onTimeToleranceS(86_400)).toBe(60)
  })
})

describe('channels summary', () => {
  it('names the pollers that are failing, stale or erroring, and leaves out healthy and paused ones', async () => {
    const fromNow = (offsetS: number) => new Date(Date.now() + offsetS * 1000).toISOString()
    const healthy = await newPoller('summary-ok')
    const stale = await newPoller('summary-stale')
    const failing = await newPoller('summary-failing')
    const erroring = await newPoller('summary-erroring')
    const paused = await newPoller('summary-paused')
    await pollerStore.setNextRun(healthy.id, fromNow(30))
    await pollerStore.setNextRun(stale.id, fromNow(-600))
    await pollerStore.setNextRun(failing.id, fromNow(30))
    await pollerStore.setNextRun(erroring.id, fromNow(30))
    await sql`UPDATE channel_poller SET failing = true, failures = 5 WHERE channel_id = ${failing.id}`
    await sql`UPDATE channel_poller SET failures = 1 WHERE channel_id = ${erroring.id}`
    await sql`UPDATE channel_poller SET enabled = false, failing = true WHERE channel_id = ${paused.id}`
    const summary = await channelsSummary()
    const mine = summary.attention.filter((entry) => entry.id.startsWith('summary-'))
    expect(mine).toEqual([
      { id: erroring.id, name: erroring.name, source: 'poller', problem: 'erroring' },
      { id: failing.id, name: failing.name, source: 'poller', problem: 'failing' },
      { id: stale.id, name: stale.name, source: 'poller', problem: 'stale' },
    ])
    expect(summary.scheduled).toBeGreaterThanOrEqual(5)
  })
})

describe('run history', () => {
  it('keeps runs for a month by time, and logs only on the newest runs', async () => {
    const poller = await newPoller('history')
    const old = new Date(Date.now() - (CHANNEL_RUN_HISTORY_DAYS + 1) * 86_400_000).toISOString()
    await sql`INSERT INTO channel_poller_run (channel_id, trigger, started_at, duration_ms, ok, items, emitted)
      VALUES (${poller.id}, 'schedule', ${old}, 1, true, 0, 0)`
    const kept = POLLER_LIMITS.runsKept + 2
    for (let i = 0; i < kept; i++) {
      const started = new Date(Date.now() - (kept - i) * 1000).toISOString()
      await pollerStore.addRun({ ...run(poller.id, '00:00:00'), started_at: started, logs: [`run ${String(i)}`] })
    }
    const runs = await pollerStore.runs(poller.id, 100)
    expect(runs).toHaveLength(kept)
    expect(runs.filter((entry) => entry.logs.length > 0)).toHaveLength(POLLER_LIMITS.runsKept)
    expect(runs.at(-1)?.logs).toEqual([])
  })
})
