import { setTimeout as sleep } from 'node:timers/promises'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { broadcast, cache, listen, redisReady } from './redis.js'

vi.hoisted(() => {
  process.env.SETI_REDIS_URL = process.env.SETI_TEST_REDIS_URL ?? '/run/seti-redis/redis.sock'
})

beforeAll(async () => {
  expect(await redisReady(5000)).toBe(true)
})

describe('redis cache', () => {
  it('round-trips JSON values until they expire', async () => {
    await cache.set('probe', { at: 1, list: ['a', null] }, 1)
    expect(await cache.get('probe')).toEqual({ at: 1, list: ['a', null] })
    await sleep(1100)
    expect(await cache.get('probe')).toBeUndefined()
  })

  it('reads many keys at once, misses included, and forgets deleted ones', async () => {
    await cache.set('one', 1, 60)
    await cache.set('three', 3, 60)
    expect(await cache.getMany(['one', 'two', 'three'])).toEqual([1, undefined, 3])
    await cache.del('one')
    expect(await cache.get('one')).toBeUndefined()
    expect(await cache.getMany([])).toEqual([])
  })

  it('remembers a loaded value for the next caller', async () => {
    const load = vi.fn(async () => Promise.resolve('octocat'))
    expect(await cache.remember('viewer', 60, load)).toBe('octocat')
    expect(await cache.remember('viewer', 60, load)).toBe('octocat')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('lets one caller claim a key until the claim runs out', async () => {
    expect(await cache.claim('refresh', 200)).toBe(true)
    expect(await cache.claim('refresh', 200)).toBe(false)
    await sleep(250)
    expect(await cache.claim('refresh', 200)).toBe(true)
  })

  it('hands broadcast messages to listeners of a matching pattern', async () => {
    const heard: [string, string][] = []
    listen('events:*', (channel, message) => heard.push([channel, message]))
    await vi.waitFor(async () => {
      await broadcast('events:1', 'hello')
      expect(heard).toContainEqual(['events:1', 'hello'])
    })
    await broadcast('other:1', 'ignored')
    await sleep(50)
    expect(heard.some(([channel]) => channel === 'other:1')).toBe(false)
  })
})
