import { MOD_LIMITS, type ModEvent } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import type { ModEventResult, ModLogicJob } from './child.js'
import { createModEvents, type ModEventsDeps, type ModLogicTarget } from './events.js'

const target = (modId: string): ModLogicTarget => ({
  modId,
  name: modId.charAt(0).toUpperCase() + modId.slice(1),
  version: '1.0.0',
  hash: 'a'.repeat(64),
  script: 'export default {}',
  grants: ['storage'],
  scopes: {},
})

const command = (name: string): ModEvent => ({ kind: 'command', command: name, args: {} })
const schedule = (id: string): ModEvent => ({
  kind: 'schedule',
  scheduleId: id,
  since: null,
  now: '2026-11-04T10:00:00Z',
})

const ok = (value: unknown, cpuMs = 10): ModEventResult => ({
  ok: true,
  value,
  logs: [],
  usage: { cpuMs, calls: 0 },
  refused: [],
})
const failed: ModEventResult = {
  ok: false,
  error: { code: 'failed', message: 'Error: boom (line 1)' },
  logs: [],
  usage: { cpuMs: 5, calls: 0 },
  refused: [],
}

const label = (job: ModLogicJob) =>
  `${job.run.modId}:${job.event.kind === 'command' ? job.event.command : job.event.kind}`

/** A runner whose events end when the test says, so queues can be watched as they fill. */
function harness(overrides: Partial<ModEventsDeps> = {}) {
  const started: string[] = []
  const waiting: ((result: ModEventResult) => void)[] = []
  const recorded: string[] = []
  const turnedOff: string[] = []
  const paused: string[] = []
  let clock = Date.parse('2026-11-04T10:00:00Z')
  let auto: ((job: ModLogicJob) => ModEventResult) | null = null
  const events = createModEvents({
    concurrency: 1,
    run: async (job) => {
      started.push(label(job))
      if (auto !== null) {
        return auto(job)
      }
      return new Promise((resolve) => waiting.push(resolve))
    },
    target: async (modId) => Promise.resolve(modId === 'gone' ? null : target(modId)),
    record: async (_target, event, result) => {
      recorded.push(`${event.kind}:${result.ok ? 'ok' : result.error.code}`)
      return Promise.resolve()
    },
    usedToday: async () => Promise.resolve(0),
    turnOff: async (mod, reason) => {
      turnedOff.push(`${mod.modId}: ${reason}`)
      return Promise.resolve()
    },
    paused: async (mod, reason) => {
      paused.push(`${mod.modId}: ${reason}`)
      return Promise.resolve()
    },
    now: () => clock,
    ...overrides,
  })
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return {
    events,
    started,
    recorded,
    turnedOff,
    paused,
    settle,
    finish: async (result: ModEventResult = ok(null)) => {
      waiting.shift()?.(result)
      await settle()
    },
    always: (fn: (job: ModLogicJob) => ModEventResult) => {
      auto = fn
    },
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('mod events', () => {
  it('runs one event per mod at a time and takes mods in turn', async () => {
    const h = harness()
    const results = [
      h.events.fire('alpha', command('a1'), { caller: 'user' }),
      h.events.fire('alpha', command('a2'), { caller: 'user' }),
      h.events.fire('alpha', command('a3'), { caller: 'user' }),
      h.events.fire('beta', command('b1'), { caller: 'ea' }),
    ]
    await h.settle()
    for (let i = 0; i < 4; i++) {
      await h.finish(ok(i))
    }
    expect(h.started).toEqual(['alpha:a1', 'beta:b1', 'alpha:a2', 'alpha:a3'])
    expect((await Promise.all(results)).map((result) => result.ok)).toEqual([true, true, true, true])
  })

  it('hands the runner the event with Seti grants, a fresh id and the schedule wall time', async () => {
    const jobs: ModLogicJob[] = []
    const h = harness({
      run: async (job) => {
        jobs.push(job)
        return Promise.resolve(ok(null))
      },
    })
    await h.events.fire('alpha', schedule('digest'), { caller: 'schedule' })
    await h.events.fire('alpha', command('go'), { caller: 'agent', agentId: 'task-1' })
    expect(jobs.map((job) => [job.wallMs, job.run.caller, job.agentId])).toEqual([
      [MOD_LIMITS.scheduleWallMs, 'schedule', undefined],
      [MOD_LIMITS.wallMs, 'agent', 'task-1'],
    ])
    expect(jobs[0]?.run.eventId).not.toBe(jobs[1]?.run.eventId)
    expect(jobs[0]?.run.grants).toEqual(['storage'])
  })

  it('refuses commands when the queue is full and drops the oldest background event instead', async () => {
    const h = harness()
    void h.events.fire('alpha', command('running'), { caller: 'user' })
    await h.settle()
    const queued = [h.events.fire('alpha', schedule('old'), { caller: 'schedule' })]
    for (let i = 1; i < MOD_LIMITS.queuePerMod; i++) {
      queued.push(h.events.fire('alpha', command(`c${String(i)}`), { caller: 'user' }))
    }
    await h.settle()
    expect(await h.events.fire('alpha', command('late'), { caller: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'busy', message: 'Alpha is busy; try again' },
    })
    void h.events.fire('alpha', schedule('new'), { caller: 'schedule' })
    expect(await queued[0]).toMatchObject({
      ok: false,
      error: { code: 'busy', message: "Alpha's queue was full, so this schedule event was dropped" },
    })
    expect(h.recorded).toEqual(['command:busy', 'schedule:busy'])
  })

  it('takes at most 60 events a minute from a mod', async () => {
    const h = harness()
    h.always(() => ok(null))
    for (let i = 0; i < MOD_LIMITS.eventsPerMinute; i++) {
      expect(await h.events.fire('alpha', command('go'), { caller: 'user' })).toMatchObject({ ok: true })
    }
    expect(await h.events.fire('alpha', command('go'), { caller: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'busy', message: 'Alpha is busy; try again' },
    })
    h.advance(60_001)
    expect(await h.events.fire('alpha', command('go'), { caller: 'user' })).toMatchObject({ ok: true })
  })

  it('backs off after 5 failures in a row, doubling, and turns a flaky mod off after 20 in an hour', async () => {
    const h = harness()
    h.always(() => failed)
    for (let i = 0; i < MOD_LIMITS.failuresBeforeBackoff; i++) {
      await h.events.fire('alpha', command('go'), { caller: 'user' })
    }
    expect(await h.events.fire('alpha', command('go'), { caller: 'user' })).toMatchObject({
      error: { code: 'busy', message: 'Alpha failed 5 times in a row; it runs again in 1 min' },
    })
    h.advance(60_001)
    await h.events.fire('alpha', command('go'), { caller: 'user' })
    expect(await h.events.fire('alpha', command('go'), { caller: 'user' })).toMatchObject({
      error: { message: 'Alpha failed 6 times in a row; it runs again in 2 min' },
    })
    expect(h.turnedOff).toEqual([])
    const flaky = harness()
    let runs = 0
    flaky.always(() => (++runs % 5 === 0 ? ok(null) : failed))
    for (let i = 0; i < 25; i++) {
      await flaky.events.fire('alpha', schedule('tick'), { caller: 'schedule' })
    }
    expect(flaky.turnedOff).toEqual(['alpha: Alpha was turned off: it failed 20 times in an hour'])
  })

  it('pauses a mod that used its compute for the day until midnight', async () => {
    const h = harness({ usedToday: async () => Promise.resolve(MOD_LIMITS.dailyCpuMs - 100) })
    h.always(() => ok(null, 200))
    expect(await h.events.fire('alpha', command('go'), { caller: 'user' })).toMatchObject({ ok: true })
    expect(h.paused).toEqual(['alpha: Alpha used its 600 s of compute for today'])
    expect(await h.events.fire('alpha', command('go'), { caller: 'user' })).toMatchObject({
      error: { code: 'busy', message: 'Alpha used its compute for today; it runs again at midnight' },
    })
    h.advance(24 * 60 * 60_000)
    expect(await h.events.fire('alpha', command('go'), { caller: 'user' })).toMatchObject({ ok: true })
  })

  it('runs nothing for a mod that is off, and ends queued events when it is forgotten', async () => {
    const h = harness()
    expect(await h.events.fire('gone', command('go'), { caller: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'denied', message: 'The mod gone is off' },
    })
    void h.events.fire('alpha', command('first'), { caller: 'user' })
    await h.settle()
    const queued = h.events.fire('alpha', command('second'), { caller: 'user' })
    await h.settle()
    h.events.forget('alpha')
    expect(await queued).toMatchObject({ ok: false, error: { code: 'denied', message: 'Alpha was turned off' } })
    expect(h.started).toEqual(['alpha:first'])
  })
})
