import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLatencyProbe, latencyStats } from '@/lib/latency'

describe('latencyStats', () => {
  it('is null without an answered ping', () => {
    expect(latencyStats([])).toBeNull()
    expect(latencyStats([null, null])).toBeNull()
  })

  it('takes the median and the mean step between answers, and counts lost pings', () => {
    expect(latencyStats([40, null, 10, 30, 20])).toEqual({ median: 25, jitter: 20, count: 4, lost: 1 })
    expect(latencyStats([12, 18, 15])).toEqual({ median: 15, jitter: 4.5, count: 3, lost: 0 })
    expect(latencyStats([7])).toEqual({ median: 7, jitter: 0, count: 1, lost: 0 })
  })
})

describe('createLatencyProbe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const setup = (visible = true) => {
    let calls = 0
    let inFlight = 0
    let most = 0
    const ping = async () => {
      calls += 1
      inFlight += 1
      most = Math.max(most, inFlight)
      await Promise.resolve()
      inFlight -= 1
      if (calls === 3) {
        throw new Error('timeout')
      }
      return calls * 10
    }
    const probe = createLatencyProbe(ping, () => visible)
    return { probe, calls: () => calls, most: () => most }
  }

  it('bursts five pings one at a time when watched, then one every two seconds', async () => {
    const { probe, calls, most } = setup()
    const stop = probe.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls()).toBe(5)
    expect(most()).toBe(1)
    expect(probe.getSnapshot()).toEqual({ results: [10, 20, null, 40, 50], measuring: false })
    await vi.advanceTimersByTimeAsync(4000)
    expect(calls()).toBe(7)
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(7)
  })

  it('samples every 30 s only while the page is visible', async () => {
    const shown = setup(true)
    const stop = shown.probe.keepSampling()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(shown.calls()).toBe(0)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(shown.calls()).toBe(2)
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(shown.calls()).toBe(2)

    const hidden = setup(false)
    const stopHidden = hidden.probe.keepSampling()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(hidden.calls()).toBe(0)
    stopHidden()
  })

  it('keeps the last ten round trips', async () => {
    const { probe } = setup()
    const stop = probe.watch()
    await vi.advanceTimersByTimeAsync(20_000)
    stop()
    expect(probe.getSnapshot().results).toHaveLength(10)
    expect(probe.getSnapshot().results.at(-1)).toBe(150)
  })

  it('pauses the watch while the page is hidden, and forgets on request', async () => {
    const { probe, calls } = setup(false)
    const stop = probe.watch()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls()).toBe(5)
    probe.forget()
    expect(probe.getSnapshot().results).toEqual([])
    stop()
  })
})
