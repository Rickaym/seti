import { describe, expect, it } from 'vitest'
import {
  backoffDelayMs,
  catchUpDelayMs,
  createLimiter,
  createPollerScheduler,
  gridJitterMs,
  nextSlot,
  PollerBusyError,
  type SchedulablePoller,
} from './scheduler.js'

describe('timing', () => {
  it('backs off by doubling for each failure in a row, up to six hours but never under the interval', () => {
    expect(backoffDelayMs(60, 1, 0.5)).toBe(120_000)
    expect(backoffDelayMs(60, 3, 0.5)).toBe(480_000)
    expect(backoffDelayMs(60, 20, 0.5)).toBe(6 * 3600_000)
    expect(backoffDelayMs(86_400, 2, 0.5)).toBe(86_400_000)
    expect(backoffDelayMs(300, 1, 0)).toBe(540_000)
  })

  it('takes the first slot after now on the grid, skipping missed ones', () => {
    expect(nextSlot(0, 60, 0)).toBe(60_000)
    expect(nextSlot(0, 60, 59_999)).toBe(60_000)
    expect(nextSlot(0, 60, 60_000)).toBe(120_000)
    expect(nextSlot(0, 60, 1_000_000)).toBe(1_020_000)
    expect(nextSlot(500_000, 60, 0)).toBe(560_000)
  })

  it('keeps a daily poller within seconds of its slot, and catches up a 60 s poller within 15 s', () => {
    expect(gridJitterMs(86_400, 0.999)).toBeLessThanOrEqual(5000)
    expect(gridJitterMs(60, 0.999)).toBeLessThanOrEqual(1200)
    expect(catchUpDelayMs(60, 0.999)).toBeLessThanOrEqual(15_000)
    expect(catchUpDelayMs(86_400, 0.999)).toBeLessThanOrEqual(60_000)
  })
})

describe('createLimiter', () => {
  it('runs at most the limit at once, the rest in order', async () => {
    const limit = createLimiter(2)
    let active = 0
    let peak = 0
    const order: number[] = []
    const job = (n: number) => async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push(n)
      active -= 1
    }
    await Promise.all([1, 2, 3, 4, 5].map(async (n) => limit(job(n))))
    expect(peak).toBe(2)
    expect(order).toEqual([1, 2, 3, 4, 5])
  })
})

interface Harness {
  pollers: Map<string, SchedulablePoller>
  timers: { fn: () => void; ms: number; cleared: boolean }[]
  runs: string[]
  dues: (string | null)[]
  release: () => void
  failures: number
  /** When set, a run throws this instead of resolving. */
  throws: Error | null
  /** When set, a run ends as stopped by a shutdown. */
  interrupted: boolean
  stale: string[]
  errors: unknown[]
  watches: number
  now: number
}

interface HarnessOptions {
  hold?: boolean
  concurrency?: number
  /** Shares stored pollers with an earlier harness, as a restart shares the database. */
  pollers?: Map<string, SchedulablePoller>
}

function harness(pollers: SchedulablePoller[], options: HarnessOptions = {}) {
  const state: Harness = {
    pollers: options.pollers ?? new Map(pollers.map((poller) => [poller.id, poller])),
    timers: [],
    runs: [],
    dues: [],
    release: () => undefined,
    failures: 0,
    throws: null,
    interrupted: false,
    stale: [],
    errors: [],
    watches: 0,
    now: Date.parse('2026-09-30T12:00:00Z'),
  }
  let gate = Promise.resolve()
  if (options.hold === true) {
    gate = new Promise((resolve) => {
      state.release = resolve
    })
  }
  const scheduler = createPollerScheduler({
    list: async () => Promise.resolve([...state.pollers.values()]),
    get: async (id) => Promise.resolve(state.pollers.get(id)),
    run: async (id, _trigger, dueAt) => {
      state.runs.push(id)
      state.dues.push(dueAt)
      await gate
      if (state.throws !== null) {
        throw state.throws
      }
      return state.interrupted ? null : state.failures
    },
    setNextRun: async (id, at) => {
      const stored = state.pollers.get(id)
      if (stored !== undefined) {
        state.pollers.set(id, { ...stored, next_run_at: at })
      }
      return Promise.resolve()
    },
    concurrency: options.concurrency ?? 3,
    onError: (e) => {
      state.errors.push(e)
    },
    onStale: (id, reason) => {
      state.stale.push(`${id}: ${reason}`)
    },
    repeat: () => {
      state.watches += 1
      return () => {
        state.watches -= 1
      }
    },
    now: () => state.now,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      state.timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => {
      const cleared = state.timers.find((entry) => (entry as unknown) === timer)
      if (cleared !== undefined) {
        cleared.cleared = true
      }
    },
  })
  return { state, scheduler }
}

const poller = (id: string, extra: Partial<SchedulablePoller> = {}): SchedulablePoller => ({
  id,
  interval_s: 300,
  enabled: true,
  failures: 0,
  next_run_at: null,
  ...extra,
})

const flush = async () => {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve()
  }
}

describe('createPollerScheduler', () => {
  it('spreads first runs over a minute, keeps stored times, and skips paused pollers', async () => {
    const { state, scheduler } = harness([
      poller('a'),
      poller('b', { next_run_at: '2026-09-30T12:02:00Z' }),
      poller('c', { enabled: false }),
    ])
    await scheduler.start()
    expect(scheduler.scheduledIds()).toEqual(['a', 'b'])
    expect(state.timers.map((timer) => timer.ms)).toEqual([30_000, 120_000])
  })

  it('reschedules each run on its grid, and backs off after failures', async () => {
    const { state, scheduler } = harness([poller('a')])
    await scheduler.start()
    state.timers[0]?.fn()
    await flush()
    expect(state.runs).toEqual(['a'])
    expect(state.timers[1]?.ms).toBe(332_500)
    expect(state.dues).toEqual(['2026-09-30T12:00:30.000Z'])
    expect(state.pollers.get('a')?.next_run_at).toBe('2026-09-30T12:05:30.000Z')
    state.failures = 2
    state.timers[1]?.fn()
    await flush()
    expect(state.timers[2]?.ms).toBe(1_200_000)
  })

  it('runs one poll per poller at a time, and polls now on request', async () => {
    const { state, scheduler } = harness([poller('a')], { hold: true })
    await scheduler.start()
    const first = scheduler.pollNow('a')
    await flush()
    expect(state.timers[0]?.cleared).toBe(true)
    expect(scheduler.isRunning('a')).toBe(true)
    await expect(scheduler.pollNow('a')).rejects.toBeInstanceOf(PollerBusyError)
    state.release()
    await first
    expect(scheduler.isRunning('a')).toBe(false)
    expect(state.runs).toEqual(['a'])
    expect(state.dues).toEqual([null])
  })

  it('holds runs over the concurrency limit until a slot frees up', async () => {
    const { state, scheduler } = harness([poller('a'), poller('b'), poller('c')], { hold: true, concurrency: 2 })
    await scheduler.start()
    for (const timer of state.timers) {
      timer.fn()
    }
    await flush()
    expect(state.runs).toEqual(['a', 'b'])
    state.release()
    await flush()
    expect(state.runs).toEqual(['a', 'b', 'c'])
  })

  it('stops scheduling a poller that was paused or deleted', async () => {
    const { state, scheduler } = harness([poller('a')])
    await scheduler.start()
    state.pollers.set('a', poller('a', { enabled: false }))
    await scheduler.sync('a')
    expect(scheduler.scheduledIds()).toEqual([])
    state.pollers.set('a', poller('a'))
    await scheduler.sync('a')
    expect(scheduler.scheduledIds()).toEqual(['a'])
    scheduler.stop()
    expect(scheduler.scheduledIds()).toEqual([])
  })

  it('reschedules a poller whose run threw, and still reports the error to Poll now', async () => {
    const { state, scheduler } = harness([poller('a')])
    await scheduler.start()
    state.throws = new Error('database went away')
    state.timers[0]?.fn()
    await flush()
    expect(scheduler.scheduledIds()).toEqual(['a'])
    expect(state.timers[1]?.ms).toBe(332_500)
    expect(state.errors).toEqual([state.throws])
    await expect(scheduler.pollNow('a')).rejects.toThrow('database went away')
    expect(scheduler.scheduledIds()).toEqual(['a'])
    expect(scheduler.isRunning('a')).toBe(false)
  })

  it('watches from start to stop, and re-arms a poller with no timer or one long overdue', async () => {
    const { state, scheduler } = harness([poller('a'), poller('b')])
    await scheduler.start()
    expect(state.watches).toBe(1)
    await scheduler.watch()
    expect(state.stale).toEqual([])
    state.pollers.set('c', poller('c'))
    const due = Date.parse(state.pollers.get('a')?.next_run_at ?? '')
    state.now = due + 300_000 + 61_000
    await scheduler.watch()
    expect(state.stale).toEqual(['a: its run was 361 s overdue', 'b: its run was 361 s overdue', 'c: it had no timer'])
    expect(state.timers.slice(-3).map((timer) => timer.ms)).toEqual([0, 0, 0])
    scheduler.stop()
    expect(state.watches).toBe(0)
  })

  it('neither runs twice nor skips a run across a restart', async () => {
    const first = harness([poller('a')])
    await first.scheduler.start()
    first.state.timers[0]?.fn()
    await flush()
    expect(first.state.runs).toEqual(['a'])
    const due = first.state.pollers.get('a')?.next_run_at
    first.scheduler.stop()
    const second = harness([], { pollers: first.state.pollers })
    second.state.now = first.state.now + 100_000
    await second.scheduler.start()
    expect(second.state.timers.map((timer) => timer.ms)).toEqual([230_000])
    expect(second.state.pollers.get('a')?.next_run_at).toBe(due)
    second.scheduler.stop()
    const third = harness([], { pollers: first.state.pollers })
    third.state.now = first.state.now + 400_000
    await third.scheduler.start()
    expect(third.state.timers).toHaveLength(1)
    third.state.timers[0]?.fn()
    await flush()
    expect([...first.state.runs, ...second.state.runs, ...third.state.runs]).toEqual(['a', 'a'])
    expect(third.state.dues).toEqual([due])
  })

  it('keeps the grid through a long downtime: one catch-up run on the old slot, then the next slot', async () => {
    const stored = poller('a', { next_run_at: '2026-09-30T09:00:00.000Z' })
    const { state, scheduler } = harness([stored])
    await scheduler.start()
    expect(state.timers.map((timer) => timer.ms)).toEqual([30_000])
    state.timers[0]?.fn()
    await flush()
    expect(state.dues).toEqual(['2026-09-30T09:00:00.000Z'])
    expect(state.pollers.get('a')?.next_run_at).toBe('2026-09-30T12:05:00.000Z')
    expect(state.timers).toHaveLength(2)
  })

  it('runs a new or resumed poller at once, and a run on request keeps the next slot', async () => {
    const { state, scheduler } = harness([poller('a', { enabled: false })])
    await scheduler.start()
    state.pollers.set('a', poller('a'))
    await scheduler.sync('a')
    expect(state.timers.map((timer) => timer.ms)).toEqual([0])
    state.timers[0]?.fn()
    await flush()
    const slot = state.pollers.get('a')?.next_run_at
    expect(slot).toBe('2026-09-30T12:05:00.000Z')
    await scheduler.pollNow('a')
    expect(state.dues).toEqual(['2026-09-30T12:00:00.000Z', null])
    expect(state.pollers.get('a')?.next_run_at).toBe(slot)
  })

  it('leaves a run stopped by a shutdown due, so it runs after the restart', async () => {
    const { state, scheduler } = harness([poller('a')])
    await scheduler.start()
    state.interrupted = true
    const due = state.pollers.get('a')?.next_run_at
    scheduler.stop()
    state.timers[0]?.fn()
    await flush()
    await scheduler.idle()
    expect(state.pollers.get('a')?.next_run_at).toBe(due)
    expect(scheduler.scheduledIds()).toEqual([])
  })
})
