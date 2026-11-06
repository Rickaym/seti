import {
  REMINDER_LIMITS,
  type ChannelInfo,
  type ReminderChannelInfo,
  type ReminderRun,
  type ReminderTestResult,
  type TaskInput,
} from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { messages, sql, tasks } from '../db.js'
import { auditEvents } from '../store/audit.js'
import { channelStore } from '../store/channels.js'
import { eaInbox } from '../store/inbox.js'
import { after, reminderStore } from '../store/reminders.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { stopReminderScripts } from './sandbox.js'
import { runReminder } from './service.js'
import { createReminderTicker } from './ticker.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-reminders-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

afterAll(async () => {
  const { rmSync } = await import('node:fs')
  rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()
const BASE = { host: '127.0.0.1:3006', 'content-type': 'application/json' }

async function send(auth: Record<string, string>, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...BASE, ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: (await res.json()) as { data: unknown; error?: { detail: string } } }
}

async function data<T>(auth: Record<string, string>, method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(auth, method, path, body)
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return res.json.data as T
}

const COUNTER = `export default ({ state, lastOutput }) => {
  const count = (state?.count ?? 0) + 1
  return { message: 'Standup ' + count + '\\nlast: ' + lastOutput, state: { count } }
}`

async function newReminder(name: string, extra: Record<string, unknown> = {}): Promise<ReminderChannelInfo> {
  return data<ReminderChannelInfo>(USER_AUTH, 'POST', '/channels/reminders', {
    name,
    script: COUNTER,
    interval_s: 600,
    ...extra,
  })
}

async function queueTask(id: string): Promise<void> {
  await tasks.insert({ id, title: id, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  await tasks.setInputMode(id, 'queue')
}

const inputsOf = async (taskId: string): Promise<TaskInput[]> =>
  (await messages.page(taskId, 100)).messages.flatMap((row) => (row.kind === 'input' ? [row.payload] : []))

const nextRunOf = async (id: string) => (await reminderStore.get(id))?.next_run_at ?? null

const setNextRun = async (id: string, at: string | null) => {
  await sql`UPDATE channel_reminder SET next_run_at = ${at} WHERE channel_id = ${id}`
}

/** A ticker over the real claim, with a clock the test moves and runs it only counts. */
function testTicker(clock: { at: number }, ran: string[], stale: string[] = [], hang = new Set<string>()) {
  return createReminderTicker({
    claimDue: reminderStore.claimDue,
    overdue: reminderStore.overdue,
    rearm: reminderStore.rearm,
    soonest: reminderStore.soonest,
    run: async (id) => {
      ran.push(id)
      await (hang.has(id) ? new Promise(() => undefined) : Promise.resolve())
    },
    concurrency: 2,
    tickMs: 60_000,
    onError: (e) => {
      throw e
    },
    onStale: (reason) => {
      stale.push(reason)
    },
    now: () => clock.at,
  })
}

describe('reminder scheduling', () => {
  it('times the first run an interval after creating, and none while paused', async () => {
    const before = Date.now()
    const reminder = await newReminder('Timed')
    const next = Date.parse(reminder.reminder.next_run_at ?? '')
    expect(next - before).toBeGreaterThanOrEqual(600_000 - 1000)
    expect(next - Date.now()).toBeLessThanOrEqual(600_000)
    const paused = await data<ReminderChannelInfo>(USER_AUTH, 'PUT', `/channels/reminders/${reminder.id}`, {
      enabled: false,
    })
    expect(paused.reminder).toMatchObject({ status: 'paused', next_run_at: null })
    expect(await nextRunOf(reminder.id)).toBeNull()
  })

  it('runs a due reminder once per tick on its grid, and not one that is not due', async () => {
    const due = await newReminder('Due now')
    const later = await newReminder('Not due')
    const at = Date.parse('2026-10-19T09:00:00.000Z')
    await setNextRun(due.id, '2026-10-19T08:59:59.000Z')
    await setNextRun(later.id, '2026-10-19T09:00:01.000Z')
    const ran: string[] = []
    const clock = { at }
    const ticker = testTicker(clock, ran)
    await ticker.tick()
    expect(ran.filter((id) => id === due.id || id === later.id)).toEqual([due.id])
    expect(await nextRunOf(due.id)).toBe(after('2026-10-19T08:59:59.000Z', 600))
    await ticker.tick()
    expect(ran.filter((id) => id === due.id)).toHaveLength(1)
    clock.at = at + 2000
    await ticker.tick()
    expect(ran.filter((id) => id === due.id || id === later.id)).toEqual([due.id, later.id])
  })

  it('never fires twice when two tickers, such as a restart beside the old process, claim at once', async () => {
    const reminder = await newReminder('Raced')
    await setNextRun(reminder.id, '2026-10-19T10:00:00.000Z')
    const ran: string[] = []
    const clock = { at: Date.parse('2026-10-19T10:00:05.000Z') }
    const tickers = Array.from({ length: 4 }, () => testTicker(clock, ran))
    await Promise.all(tickers.map(async (ticker) => ticker.tick()))
    expect(ran.filter((id) => id === reminder.id)).toHaveLength(1)
  })

  it('keeps its next run across a restart and fires an overdue one once', async () => {
    const reminder = await newReminder('Restarted')
    await setNextRun(reminder.id, '2026-10-19T11:00:00.000Z')
    const ran: string[] = []
    const clock = { at: Date.parse('2026-10-19T10:59:00.000Z') }
    await testTicker(clock, ran).tick()
    expect(ran).not.toContain(reminder.id)
    expect(await nextRunOf(reminder.id)).toBe('2026-10-19T11:00:00.000Z')

    clock.at = Date.parse('2026-10-19T13:00:00.000Z')
    const restarted = testTicker(clock, ran)
    await restarted.tick()
    await restarted.tick()
    await testTicker(clock, ran).tick()
    expect(ran.filter((id) => id === reminder.id)).toHaveLength(1)
    expect(await nextRunOf(reminder.id)).toBe('2026-10-19T13:10:00.000Z')
  })

  it('keeps its grid when ticks come late, so runs never drift', async () => {
    const reminder = await newReminder('Grid')
    await setNextRun(reminder.id, '2026-10-23T09:00:00.000Z')
    const ran: string[] = []
    const clock = { at: Date.parse('2026-10-23T09:00:07.000Z') }
    const ticker = testTicker(clock, ran)
    await ticker.tick()
    expect(await nextRunOf(reminder.id)).toBe('2026-10-23T09:10:00.000Z')
    clock.at = Date.parse('2026-10-23T09:10:09.000Z')
    await ticker.tick()
    expect(await nextRunOf(reminder.id)).toBe('2026-10-23T09:20:00.000Z')
    expect(ran.filter((id) => id === reminder.id)).toHaveLength(2)
  })

  it('leaves a run Seti stopped as it shut down due, so it runs after the restart', async () => {
    const reminder = await newReminder('Cut short', {
      script: 'export default () => new Promise((resolve) => setTimeout(() => resolve("late"), 4000))',
    })
    const running = runReminder(reminder.id, 'schedule', '2026-10-24T09:00:00.000Z')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    stopReminderScripts()
    await running
    expect(await nextRunOf(reminder.id)).toBe('2026-10-24T09:00:00.000Z')
    expect(await reminderStore.runs(reminder.id, 1)).toEqual([])
    expect((await reminderStore.get(reminder.id))?.failures).toBe(0)
  })

  it('re-arms a reminder that lost its next run or fell over an interval behind', async () => {
    const lost = await newReminder('Lost')
    const behind = await newReminder('Behind')
    const fine = await newReminder('Fine')
    await setNextRun(lost.id, null)
    await setNextRun(behind.id, '2026-10-20T08:48:00.000Z')
    await setNextRun(fine.id, '2026-10-20T08:50:00.000Z')
    const ran: string[] = []
    const stale: string[] = []
    const clock = { at: Date.parse('2026-10-20T09:00:00.000Z') }
    await testTicker(clock, ran, stale).watch()
    expect(stale).toEqual(
      expect.arrayContaining([
        `re-armed reminder ${lost.id}, which had no next run`,
        `re-armed reminder ${behind.id}, which was due at 2026-10-20T08:48:00.000Z`,
      ]),
    )
    expect(stale.some((line) => line.includes(fine.id))).toBe(false)
    expect(ran.filter((id) => [lost.id, behind.id, fine.id].includes(id))).toEqual(
      expect.arrayContaining([lost.id, behind.id, fine.id]),
    )
    expect(await nextRunOf(lost.id)).toBe(after('2026-10-20T09:00:00.000Z', 600))
  })

  it('records when the schedule wanted each run, and none for a run on request', async () => {
    const reminder = await newReminder('Timed runs')
    await setNextRun(reminder.id, '2026-10-22T09:00:00.000Z')
    const clock = { at: Date.parse('2026-10-22T09:00:04.000Z') }
    const ticker = createReminderTicker({
      claimDue: async (at, limit) =>
        (await reminderStore.claimDue(at, limit)).filter((claimed) => claimed.id === reminder.id),
      overdue: async () => Promise.resolve([]),
      rearm: async () => Promise.resolve(),
      soonest: async () => Promise.resolve(null),
      run: runReminder,
      concurrency: 1,
      tickMs: 60_000,
      onError: (e) => {
        throw e
      },
      onStale: () => undefined,
      now: () => clock.at,
    })
    await ticker.tick()
    await ticker.runNow(reminder.id)
    const runs = await reminderStore.runs(reminder.id, 2)
    expect(runs.map((run) => [run.trigger, run.due_at])).toEqual([
      ['manual', null],
      ['schedule', '2026-10-22T09:00:00.000Z'],
    ])
  })

  it('lets the next tick go ahead when one hangs', async () => {
    const stuck = await newReminder('Stuck')
    const next = await newReminder('Next')
    await setNextRun(stuck.id, '2026-10-21T09:00:00.000Z')
    await setNextRun(next.id, '2026-10-21T09:06:00.000Z')
    const ran: string[] = []
    const stale: string[] = []
    const clock = { at: Date.parse('2026-10-21T09:00:01.000Z') }
    const ticker = testTicker(clock, ran, stale, new Set([stuck.id]))
    void ticker.tick()
    await vi.waitFor(() => {
      expect(ran).toContain(stuck.id)
    })
    clock.at = Date.parse('2026-10-21T09:06:02.000Z')
    await ticker.tick()
    expect(ran).toContain(next.id)
    expect(stale).toEqual([expect.stringContaining('a tick ran over 5 min')])
  })
})

describe('reminder runs', () => {
  it('delivers each message to its subscribers as a channel event, with its state carried over', async () => {
    const reminder = await newReminder('Standup', { subscribe_ea: true })
    await queueTask('standup-agent')
    await data(USER_AUTH, 'POST', `/channels/${reminder.id}/subscriptions`, {
      target: 'task',
      task_id: 'standup-agent',
    })
    await runReminder(reminder.id, 'schedule')
    await runReminder(reminder.id, 'manual')

    const events = await channelStore.recent(reminder.id, 10)
    expect(events.map((event) => [event.kind, event.title, event.detail])).toEqual([
      ['reminder', 'Standup 2', 'last: Standup 1\nlast: null'],
      ['reminder', 'Standup 1', 'last: null'],
    ])
    expect(await inputsOf('standup-agent')).toEqual([
      expect.objectContaining({ source: 'channel', channel: 'Standup', kind: 'reminder', title: 'Standup 1' }),
      expect.objectContaining({ source: 'channel', channel: 'Standup', kind: 'reminder', title: 'Standup 2' }),
    ])
    const inbox = await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 50)
    expect(inbox.map((item) => item.title)).toEqual(expect.arrayContaining(['Standup 1', 'Standup 2']))
    const [delivery] = await channelStore.deliveries(reminder.id, 1)
    expect(delivery).toMatchObject({
      status: 'accepted',
      http_status: 0,
      reason: 'sent to the EA inbox, standup-agent',
    })

    const saved = await reminderStore.get(reminder.id)
    expect(saved).toMatchObject({ state: { count: 2 }, last_output: 'Standup 2\nlast: Standup 1\nlast: null' })
    const runs = await reminderStore.runs(reminder.id, 10)
    expect(runs.map((run) => [run.trigger, run.outcome, run.message?.split('\n')[0]])).toEqual([
      ['manual', 'ok', 'Standup 2'],
      ['schedule', 'ok', 'Standup 1'],
    ])
  })

  it('records empty, failed and timed out runs, and tells subscribers once when failing and recovered', async () => {
    const reminder = await newReminder('Flaky', {
      script:
        "export default ({ state }) => { if (state === null) return { message: '', state: 1 }; throw new Error('no') }",
      subscribe_ea: true,
    })
    await runReminder(reminder.id, 'schedule')
    for (let i = 0; i < REMINDER_LIMITS.failuresBeforeFailing; i++) {
      await runReminder(reminder.id, 'schedule')
    }
    const failing = await data<ReminderChannelInfo>(USER_AUTH, 'GET', `/channels/reminders/${reminder.id}`)
    expect(failing.reminder).toMatchObject({ status: 'failing', failures: REMINDER_LIMITS.failuresBeforeFailing })
    expect(failing.recent.map((event) => [event.kind, event.severity, event.title])).toEqual([
      ['reminder_failed', 'warning', 'Flaky is failing'],
    ])

    await data(USER_AUTH, 'PUT', `/channels/reminders/${reminder.id}`, { script: "export default () => 'back'" })
    await runReminder(reminder.id, 'manual')
    const recovered = await data<ReminderChannelInfo>(USER_AUTH, 'GET', `/channels/reminders/${reminder.id}`)
    expect(recovered.reminder.status).toBe('ok')
    expect(recovered.recent.map((event) => event.kind)).toEqual(['reminder_recovered', 'reminder', 'reminder_failed'])
    const runs = await data<ReminderRun[]>(USER_AUTH, 'GET', `/channels/reminders/${reminder.id}/runs`)
    expect(runs.map((run) => run.outcome)).toEqual(['ok', 'error', 'error', 'error', 'empty'])
    expect(runs[1]?.error).toBe('Error: no')
    expect(recovered.reminder.runs).toHaveLength(3)
  })

  it('records a run whose message Seti could not deliver as failed', async () => {
    const reminder = await newReminder('Undelivered')
    const broken = vi.spyOn(channelStore, 'accept').mockRejectedValueOnce(new Error('connection reset'))
    await runReminder(reminder.id, 'schedule')
    broken.mockRestore()
    const [run] = await reminderStore.runs(reminder.id, 1)
    expect(run).toMatchObject({ outcome: 'error', error: 'Seti could not deliver the message: connection reset' })
    expect((await reminderStore.get(reminder.id))?.failures).toBe(1)
  })

  it('records a timeout as a failed run', async () => {
    const reminder = await newReminder('Stuck', { script: 'export default () => { for (;;) {} }' })
    await runReminder(reminder.id, 'manual')
    const [run] = await reminderStore.runs(reminder.id, 1)
    expect(run).toMatchObject({ outcome: 'timeout', error: 'The script ran over its 5 s timeout' })
    expect((await reminderStore.get(reminder.id))?.failures).toBe(1)
  })
})

describe('reminder routes', () => {
  it('test runs a draft without delivering or storing, and with a saved reminder its last run', async () => {
    const reminder = await newReminder('Tested', { subscribe_ea: true })
    const draft = await data<ReminderTestResult>(USER_AUTH, 'POST', '/channels/reminders/test', { script: COUNTER })
    expect(draft).toMatchObject({ outcome: 'ok', message: 'Standup 1\nlast: null', state: { count: 1 } })
    await runReminder(reminder.id, 'schedule')
    const saved = await data<ReminderTestResult>(USER_AUTH, 'POST', '/channels/reminders/test', {
      script: COUNTER,
      channel_id: reminder.id,
    })
    expect(saved).toMatchObject({ outcome: 'ok', message: 'Standup 2\nlast: Standup 1\nlast: null' })
    expect(await reminderStore.get(reminder.id)).toMatchObject({ state: { count: 1 } })
    expect(await channelStore.recent(reminder.id, 10)).toHaveLength(1)
  })

  it('lists reminders with other channels, runs now, audits and deletes, and the EA may do all of it', async () => {
    const reminder = await data<ReminderChannelInfo>(EA_AUTH, 'POST', '/channels/reminders', {
      name: 'EA made',
      script: "export default () => 'from the EA'",
    })
    expect(reminder.reminder).toMatchObject({ interval_s: REMINDER_LIMITS.intervalDefaultS, status: 'pending' })
    const listed = await data<ChannelInfo[]>(USER_AUTH, 'GET', '/channels')
    expect(listed.find((info) => info.id === reminder.id)).toMatchObject({ source: 'reminder', preset: 'reminder' })

    const ran = await data<ReminderChannelInfo>(EA_AUTH, 'POST', `/channels/reminders/${reminder.id}/run`)
    expect(ran.reminder.runs[0]).toMatchObject({ trigger: 'manual', outcome: 'ok', message: 'from the EA' })
    expect(ran.deliveries[0]).toMatchObject({ reason: 'stored; no subscribers' })
    const changed = await data<ReminderChannelInfo>(EA_AUTH, 'PUT', `/channels/reminders/${reminder.id}`, {
      interval_s: 120,
      script: 'export default () => null',
    })
    expect(changed.reminder.interval_s).toBe(120)

    await data(EA_AUTH, 'DELETE', `/channels/${reminder.id}`)
    expect(await reminderStore.get(reminder.id)).toBeUndefined()
    const latest = async (kind: Parameters<typeof auditEvents.latest>[0]) => (await auditEvents.latest(kind))?.summary
    expect(await latest('system.channel_created')).toBe('Created the reminder EA made')
    expect(await latest('system.channel_polled')).toBe('Ran the reminder EA made now: ok')
    expect(await latest('system.channel_changed')).toBe('Changed the reminder EA made: script, interval_s')
    expect(await latest('system.channel_deleted')).toBe('Deleted the reminder EA made')
  })

  it('refuses a script over its size cap and an interval under a minute', async () => {
    const big = await send(USER_AUTH, 'POST', '/channels/reminders', {
      name: 'Big',
      script: 'x'.repeat(REMINDER_LIMITS.scriptMaxChars + 1),
    })
    expect(big.status).toBe(400)
    const fast = await send(USER_AUTH, 'POST', '/channels/reminders', { name: 'Fast', script: COUNTER, interval_s: 30 })
    expect(fast.status).toBe(400)
  })
})
