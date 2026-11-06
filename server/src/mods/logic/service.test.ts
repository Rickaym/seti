import { MOD_LIMITS } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { UNAVAILABLE_OPS } from './dispatch.js'
import type { ModLogicTarget } from './events.js'
import { scheduleMod } from './schedule.js'
import {
  connectModLogic,
  fireModEvent,
  localDay,
  runCommandEvent,
  runModOp,
  scheduleModEvents,
  stopModLogic,
  type ModLogicHost,
} from './service.js'
import { readModWorkers } from '../../config.js'
import { auditEvents } from '../../store/audit.js'
import { modLogs, modUsage } from '../../store/mod-logic.js'

const KEY = ['sink', 'token', 'value', '42xyz'].join('-')

const SCRIPT = `export default {
  commands: {
    summarize: async (args, ctx, seti) => {
      seti.log('summarizing for', ctx.caller, ctx.agentId)
      const team = (await seti.settings.get()).team
      let refused = null
      try { await seti.files.read('builder', '.env') } catch (e) { refused = e.code }
      const reply = await seti.fetch('https://api.sink.test/v1', { connection: 'SINK_TOKEN' })
      seti.log('upstream said', await reply.text())
      return { team, refused, status: reply.status, ok: reply.ok, args }
    },
    broken: async () => { throw new Error('nothing to summarize') },
  },
  webhooks: {
    sink: async (delivery) => [{ key: JSON.parse(delivery.body).id, title: delivery.headers['x-sink-event'] }],
  },
}`

const TARGET: ModLogicTarget = {
  modId: 'kitchen-sink',
  name: 'Kitchen sink',
  version: '1.0.0',
  hash: 'b'.repeat(64),
  script: SCRIPT,
  grants: ['connection'],
  scopes: {},
}

const host: ModLogicHost = {
  target: async (modId) => Promise.resolve(modId === TARGET.modId ? TARGET : null),
  turnOff: async () => Promise.resolve(),
  paused: async () => Promise.resolve(),
}

afterAll(() => {
  stopModLogic()
})

describe('the mod logic service', () => {
  it('runs a command in a runner, logs it without secrets, counts its compute and audits denials', async () => {
    connectModLogic({
      host,
      ops: {
        ...UNAVAILABLE_OPS,
        'settings.get': async () => Promise.resolve({ team: 'core' }),
        'connection.fetch': async (args, call) => {
          call.secret(KEY)
          return Promise.resolve({ status: 200, url: args.url, headers: [], body: `echo ${KEY}` })
        },
      },
    })
    const result = await runCommandEvent(
      'kitchen-sink',
      'summarize',
      { task: 't1' },
      { caller: 'agent', agentId: 't1' },
    )
    expect(result).toMatchObject({
      ok: true,
      value: { team: 'core', refused: 'denied', status: 200, ok: true, args: { task: 't1' } },
    })
    const lines = await modLogs.newest('kitchen-sink', 10)
    expect(lines.map((line) => [line.kind, line.line]).reverse()).toEqual([
      ['log', 'summarizing for agent t1'],
      ['log', 'upstream said echo [secret]'],
      ['refused', 'Refused files.read: kitchen-sink was not granted files.read'],
    ])
    expect(JSON.stringify(lines)).not.toContain(KEY)
    expect(await modUsage.cpuOn('kitchen-sink', localDay(Date.now()))).toBeGreaterThanOrEqual(0)
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.call_refused')).toMatchObject({
      actor: 'mod:kitchen-sink',
      summary: 'Refused files.read for kitchen-sink: kitchen-sink was not granted files.read',
    })
  })

  it('logs a failed event with its error and refuses a mod that is not running', async () => {
    const broken = await runCommandEvent('kitchen-sink', 'broken', {}, { caller: 'user' })
    expect(broken).toMatchObject({
      ok: false,
      error: { code: 'failed', message: 'Error: nothing to summarize (line 12)' },
    })
    const [line] = await modLogs.newest('kitchen-sink', 1)
    expect(line).toMatchObject({
      kind: 'error',
      level: 'error',
      line: 'The command broken failed: Error: nothing to summarize (line 12)',
    })
    const missing = await runCommandEvent('kitchen-sink', 'absent', {}, { caller: 'user' })
    expect(missing).toMatchObject({
      ok: false,
      error: { message: 'Error: logic.js has no onCommand handler for absent' },
    })
    expect(await runCommandEvent('other', 'go', {}, { caller: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'denied', message: 'The mod other is off' },
    })
  })

  it('fires a webhook event into its handler and starts and stops schedules', async () => {
    const delivered = await fireModEvent(
      'kitchen-sink',
      {
        kind: 'webhook',
        sourceId: 'sink',
        headers: { 'x-sink-event': 'issue.fixed' },
        body: JSON.stringify({ id: 'ISS-1' }),
        receivedAt: new Date().toISOString(),
      },
      { caller: 'webhook' },
    )
    expect(delivered).toMatchObject({ ok: true, value: [{ key: 'ISS-1', title: 'issue.fixed' }] })
    const stop = scheduleModEvents('kitchen-sink', [{ id: 'digest', every: '15m' }])
    stop()
  })

  it('runs a single op as the mod with its own grants, as a view does', async () => {
    expect(await runModOp('kitchen-sink', 'settings.get', {}, { caller: 'view' })).toEqual({
      ok: true,
      value: { team: 'core' },
    })
    expect(await runModOp('kitchen-sink', 'storage.get', { key: 'k' }, { caller: 'view' })).toEqual({
      ok: false,
      error: { code: 'denied', message: 'kitchen-sink was not granted storage' },
    })
    expect(await runModOp('other', 'settings.get', {}, { caller: 'view' })).toEqual({
      ok: false,
      error: { code: 'denied', message: 'The mod other is off' },
    })
  })

  it('keeps the newest log lines per mod', async () => {
    const lines = Array.from({ length: MOD_LIMITS.logKeptLines + 5 }, (_, i) => ({
      kind: 'log' as const,
      level: 'info' as const,
      line: `line ${String(i)}`,
    }))
    await modLogs.append('chatty', null, new Date().toISOString(), lines)
    const kept = await modLogs.newest('chatty', 1000)
    expect(kept).toHaveLength(MOD_LIMITS.logKeptLines)
    expect(kept[0]?.line).toBe(`line ${String(MOD_LIMITS.logKeptLines + 4)}`)
  })
})

describe('mod schedules', () => {
  it('fires each schedule after its interval plus jitter, passing when the last one ran', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-04T10:00:00Z') })
    const fired: unknown[] = []
    const stop = scheduleMod('kitchen-sink', [{ id: 'digest', every: '15m' }], {
      fire: async (_modId, event) => {
        fired.push(event)
        return Promise.resolve()
      },
      random: () => 0.5,
    })
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(fired).toEqual([])
    await vi.advanceTimersByTimeAsync(45_000)
    expect(fired).toEqual([{ kind: 'schedule', scheduleId: 'digest', since: null, now: '2026-11-04T10:15:45.000Z' }])
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 45_000)
    expect(fired[1]).toMatchObject({ since: '2026-11-04T10:15:45.000Z', now: '2026-11-04T10:31:30.000Z' })
    stop()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(fired).toHaveLength(2)
    vi.useRealTimers()
  })
})

describe('SETI_MOD_WORKERS', () => {
  it('takes 1 to 3 processes, 1 when unset', () => {
    expect(readModWorkers(undefined)).toBe(1)
    expect(readModWorkers('3')).toBe(3)
    expect(() => readModWorkers('4')).toThrow('SETI_MOD_WORKERS must be 1 to 3')
    expect(() => readModWorkers('0')).toThrow('SETI_MOD_WORKERS must be a whole number of processes, not 0')
  })
})
