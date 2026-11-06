import type { SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccountMonitor, type AccountSession } from './account.js'
import { createCapabilityCache, type ProbeSession, type ProbeTiming } from './capabilities.js'
import { cache, redisReady } from './redis.js'

vi.hoisted(() => {
  process.env.SETI_REDIS_URL = process.env.SETI_TEST_REDIS_URL ?? '/run/seti-redis/redis.sock'
})

const FAST: ProbeTiming = { pollMs: 1, pendingCapMs: 50, callTimeoutMs: 200 }
const ACCOUNT_FAST = { initTimeoutMs: 200, usageTimeoutMs: 200 }
const USAGE = { five_hour: { utilization: 10, resets_at: '2026-09-27T22:00:00+00:00' } }

const INIT: SDKControlInitializeResponse = {
  commands: [],
  agents: [],
  output_style: 'default',
  available_output_styles: ['default'],
  models: [],
  account: { email: 'me@example.com', subscriptionType: 'max' },
}

const probeSession = (): ProbeSession => ({
  initializationResult: async () => Promise.resolve(INIT),
  mcpServerStatus: async () => Promise.resolve([]),
  close: () => undefined,
})

const accountSession = (): AccountSession => ({
  initializationResult: async () => Promise.resolve(INIT),
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => Promise.resolve(USAGE),
  close: () => undefined,
})

beforeAll(async () => {
  expect(await redisReady(5000)).toBe(true)
})

describe('probes shared through Redis', () => {
  it('lets another process, or a restart, take a recent capability probe instead of probing', async () => {
    const start = vi.fn(probeSession)
    const snapshot = await createCapabilityCache(start, FAST).refresh('/srv/shared-probe')
    expect(start).toHaveBeenCalledTimes(1)

    const other = createCapabilityCache(start, FAST)
    expect(other.cached('/srv/shared-probe')).toBeUndefined()
    expect(await other.warm('/srv/shared-probe', 60_000)).toBe(true)
    expect(other.cached('/srv/shared-probe')).toEqual(snapshot)
    expect(await other.get('/srv/shared-probe')).toEqual(snapshot)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('refuses a snapshot older than asked for, and finds nothing for an unprobed directory', async () => {
    const start = vi.fn(probeSession)
    const first = createCapabilityCache(start, FAST)
    const snapshot = await first.refresh('/srv/old-probe')
    const later = Date.parse(snapshot.probed_at) + 20 * 60_000
    expect(await createCapabilityCache(start, FAST).warm('/srv/old-probe', 15 * 60_000, later)).toBe(false)
    expect(await createCapabilityCache(start, FAST).warm('/srv/never-probed', 15 * 60_000)).toBe(false)
  })

  it('shares the account probe and when the login was last verified', async () => {
    await cache.del('account:probe')
    const start = vi.fn(accountSession)
    const first = createAccountMonitor(start, ACCOUNT_FAST)
    const probe = await first.refresh()
    const other = createAccountMonitor(start, ACCOUNT_FAST)
    expect(await other.warm(60_000)).toBe(true)
    expect(await other.get()).toEqual(probe)
    expect(other.verifiedAt()).toBe(first.verifiedAt())
    expect(start).toHaveBeenCalledTimes(1)
  })
})
