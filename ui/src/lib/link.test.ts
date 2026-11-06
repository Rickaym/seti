import { describe, expect, it, vi } from 'vitest'
import type { LatencyProbe } from '@/lib/latency'
import { createLink, hintReason, judgeLatency, type LinkHints } from '@/lib/link'

const fast = [80, 90, 100, 85, 95]

describe('judgeLatency', () => {
  it('waits for five pings before judging', () => {
    expect(judgeLatency(false, [2000, 2000, 2000, 2000])).toBeNull()
  })

  it('slows above a 600 ms median and speeds up only below 300 ms', () => {
    expect(judgeLatency(false, [500, 550, 580, 590, 600])).toBeNull()
    expect(judgeLatency(false, [700, 650, 620, 640, 900])).toBe('median round trip 650 ms')
    expect(judgeLatency(true, [400, 450, 420, 410, 430])).toBe('median round trip 420 ms')
    expect(judgeLatency(true, [250, 200, 280, 260, 240])).toBeNull()
  })

  it('slows when more than a tenth of the pings are lost, never on one loss', () => {
    expect(judgeLatency(false, [...fast, null, ...fast.slice(0, 4)])).toBeNull()
    expect(judgeLatency(false, [null, ...fast, null, 90, 90, 90])).toBe('2 of the last 10 pings lost')
  })

  it('stays slow until the five latest pings all answered', () => {
    const lossy = [null, null, 90, 90, 90, 90, null, 90, 90, 90]
    expect(judgeLatency(true, lossy)).toBe('3 of the last 10 pings lost')
    expect(judgeLatency(true, [...lossy.slice(5), ...fast])).toBeNull()
  })
})

describe('hintReason', () => {
  it('slows for Data Saver and for 2g links', () => {
    expect(hintReason({ saveData: true, effectiveType: '4g' })).toBe('Data Saver is on')
    expect(hintReason({ saveData: false, effectiveType: 'slow-2g' })).toBe('the browser reports a slow-2g connection')
    expect(hintReason({ saveData: false, effectiveType: '3g' })).toBeNull()
    expect(hintReason({ saveData: false, effectiveType: null })).toBeNull()
  })
})

function fakeProbe() {
  let results: (number | null)[] = []
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }
  const release = vi.fn()
  const probe: LatencyProbe = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => ({ results, measuring: false }),
    keepSampling: () => release,
    watch: () => () => undefined,
    forget: () => {
      results = []
      notify()
    },
  }
  const push = (...more: (number | null)[]) => {
    results = [...results, ...more].slice(-10)
    notify()
  }
  return { probe, push, release }
}

function fakeEnv() {
  let online = true
  let hints: LinkHints = { saveData: false, effectiveType: null }
  let onChange: (() => void) | null = null
  return {
    env: {
      online: () => online,
      hints: () => hints,
      listen: (listener: () => void) => {
        onChange = listener
        return () => {
          onChange = null
        }
      },
    },
    setOnline: (value: boolean) => {
      online = value
      onChange?.()
    },
    setHints: (value: LinkHints) => {
      hints = value
      onChange?.()
    },
    listening: () => onChange !== null,
  }
}

describe('createLink', () => {
  it('turns slow on a poor link, keeps it through the gap, and recovers', () => {
    const { probe, push } = fakeProbe()
    const { env } = fakeEnv()
    const link = createLink(probe, env)
    const notified = vi.fn()
    const stop = link.subscribe(notified)
    push(...fast)
    expect(link.getSnapshot().slow).toBe(false)

    push(900, 900, 900, 900, 900, 900)
    expect(link.getSnapshot()).toMatchObject({ slow: true, reason: 'median round trip 900 ms' })

    push(400, 400, 400, 400, 400)
    expect(link.getSnapshot().slow).toBe(true)

    push(100, 100, 100, 100, 100, 100)
    expect(link.getSnapshot()).toEqual({ online: true, slow: false, reason: null })
    stop()
  })

  it('follows the browser hints and the online state, and forgets old pings on reconnect', () => {
    const { probe, push } = fakeProbe()
    const { env, setOnline, setHints } = fakeEnv()
    const link = createLink(probe, env)
    const stop = link.subscribe(() => undefined)

    setHints({ saveData: true, effectiveType: '4g' })
    expect(link.getSnapshot()).toMatchObject({ slow: true, reason: 'Data Saver is on' })
    setHints({ saveData: false, effectiveType: '4g' })
    expect(link.getSnapshot().slow).toBe(false)

    setOnline(false)
    push(null, null, null, null, null)
    expect(link.getSnapshot()).toMatchObject({ online: false, slow: true })
    setOnline(true)
    expect(probe.getSnapshot().results).toEqual([])
    expect(link.getSnapshot()).toEqual({ online: true, slow: false, reason: null })
    stop()
  })

  it('samples and listens only while someone subscribes', () => {
    const { probe, release } = fakeProbe()
    const { env, listening } = fakeEnv()
    const link = createLink(probe, env)
    expect(listening()).toBe(false)
    const stopA = link.subscribe(() => undefined)
    const stopB = link.subscribe(() => undefined)
    expect(listening()).toBe(true)
    stopA()
    expect(release).not.toHaveBeenCalled()
    stopB()
    expect(release).toHaveBeenCalledTimes(1)
    expect(listening()).toBe(false)
  })
})
