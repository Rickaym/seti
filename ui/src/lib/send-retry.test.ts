import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Link, LinkState } from '@/lib/link'
import { isRetryable, linkConnectivity, SendTimeout, withRetry, type Connectivity } from '@/lib/send-retry'

const online: Connectivity = { online: () => true, whenOnline: async () => Promise.resolve() }

class Status extends Error {
  readonly status: number

  constructor(status: number) {
    super(`status ${String(status)}`)
    this.status = status
  }
}

/** An attempt that answers from the script in turn and records the signals it got. */
function scripted(steps: (() => Promise<string>)[]) {
  const calls: AbortSignal[] = []
  const attempt = async (signal: AbortSignal) => {
    calls.push(signal)
    const step = steps[calls.length - 1]
    if (step === undefined) {
      throw new Error('no more steps')
    }
    return step()
  }
  return { attempt, calls }
}

const never = async () => new Promise<string>(() => undefined)
const fault = async () => Promise.reject(new TypeError('Failed to fetch'))

describe('isRetryable', () => {
  it('retries network faults, timeouts and gateway errors only', () => {
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true)
    expect(isRetryable(new SendTimeout())).toBe(true)
    expect([502, 503, 504].map((status) => isRetryable(new Status(status)))).toEqual([true, true, true])
    for (const status of [400, 404, 409, 422, 500]) {
      expect(isRetryable(new Status(status))).toBe(false)
    }
    expect(isRetryable(new Error('boom'))).toBe(false)
  })
})

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('backs off 1s, 3s, 8s, 15s and then gives up', async () => {
    const { attempt, calls } = scripted([fault, fault, fault, fault, fault, fault])
    const retries: number[] = []
    const settled = withRetry(attempt, { connectivity: online, onRetrying: (n) => retries.push(n) }).catch(
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(8000)
    expect(calls).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toHaveLength(5)
    expect(await settled).toBeInstanceOf(TypeError)
    expect(retries).toEqual([1, 2, 3, 4])
  })

  it('times an attempt out and retries it', async () => {
    const { attempt, calls } = scripted([never, async () => Promise.resolve('sent')])
    const result = withRetry(attempt, { connectivity: online, timeoutMs: 20_000 })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(calls[0]?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls[0]?.reason).toBeInstanceOf(SendTimeout)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe('sent')
    expect(calls).toHaveLength(2)
  })

  it('retries a 503 and never a 4xx', async () => {
    const gateway = scripted([async () => Promise.reject(new Status(503)), async () => Promise.resolve('ok')])
    const retried = withRetry(gateway.attempt, { connectivity: online })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await retried).toBe('ok')

    const refused = scripted([async () => Promise.reject(new Status(409)), async () => Promise.resolve('never')])
    await expect(withRetry(refused.attempt, { connectivity: online })).rejects.toThrow('status 409')
    expect(refused.calls).toHaveLength(1)
  })

  it('stops the timeout once the answer starts streaming', async () => {
    const answer: { finish?: (value: string) => void } = {}
    const attempt = async (_signal: AbortSignal, answered: () => void) => {
      answered()
      return new Promise<string>((resolve) => {
        answer.finish = resolve
      })
    }
    const result = withRetry(attempt, { connectivity: online, timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(10_000)
    answer.finish?.('streamed')
    expect(await result).toBe('streamed')
  })

  it('waits while offline and retries once the network is back', async () => {
    let up = false
    let back: () => void = () => undefined
    const connectivity: Connectivity = {
      online: () => up,
      whenOnline: async () =>
        new Promise<void>((resolve) => {
          back = resolve
        }),
    }
    const { attempt, calls } = scripted([fault, async () => Promise.resolve('sent')])
    const result = withRetry(attempt, { connectivity })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    up = true
    back()
    expect(await result).toBe('sent')
    expect(calls).toHaveLength(2)
  })

  it('stops retrying when the caller aborts', async () => {
    const controller = new AbortController()
    const { attempt, calls } = scripted([fault, never])
    const settled = withRetry(attempt, { connectivity: online, signal: controller.signal }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await settled).toBeInstanceOf(TypeError)
    expect(calls).toHaveLength(1)
  })
})

describe('linkConnectivity', () => {
  it('follows the link and waits for it to come back online', async () => {
    let state: LinkState = { online: false, slow: false, reason: null }
    const listeners = new Set<() => void>()
    const link: Link = {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSnapshot: () => state,
    }
    const connectivity = linkConnectivity(link)
    expect(connectivity.online()).toBe(false)
    let back = false
    const waiting = connectivity.whenOnline().then(() => {
      back = true
    })
    await Promise.resolve()
    expect(back).toBe(false)
    state = { ...state, online: true }
    for (const listener of listeners) {
      listener()
    }
    await waiting
    expect(back).toBe(true)
    expect(listeners.size).toBe(0)
  })
})
