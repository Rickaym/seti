import { describe, expect, it, vi } from 'vitest'
import { cachedPrHeads } from './github-cache.js'
import { broadcast, cache, listen, redisReady } from './redis.js'

vi.hoisted(() => {
  process.env.SETI_REDIS_URL = '/nonexistent/seti-redis.sock'
})

const gh = vi.hoisted(() => ({
  fetchPrHeads: vi.fn(async (urls: readonly string[]) =>
    Promise.resolve(new Map(urls.map((url) => [url, { url, head_ref: 'fix/x', head_repo: 'e2e/web' }]))),
  ),
}))

vi.mock('./github.js', () => ({ fetchPrHeads: gh.fetchPrHeads, gh: vi.fn() }))

describe('redis when it is down', () => {
  it('reads every key as a miss and never throws', async () => {
    expect(await redisReady(200)).toBe(false)
    expect(await cache.get('anything')).toBeUndefined()
    expect(await cache.getMany(['a', 'b'])).toEqual([undefined, undefined])
    await expect(cache.set('anything', { a: 1 }, 60)).resolves.toBeUndefined()
    await expect(cache.del('anything')).resolves.toBeUndefined()
    await expect(broadcast('task:1', 'lost')).resolves.toBeUndefined()
    expect(() => {
      listen('task:*', () => undefined)
    }).not.toThrow()
  })

  it('lets every process refresh, since none can coordinate', async () => {
    expect(await cache.claim('refresh', 1000)).toBe(true)
    expect(await cache.claim('refresh', 1000)).toBe(true)
  })

  it('asks GitHub every time instead of failing', async () => {
    const url = 'https://github.com/e2e/web/pull/1'
    expect((await cachedPrHeads([url])).get(url)?.head_ref).toBe('fix/x')
    expect((await cachedPrHeads([url])).get(url)?.head_ref).toBe('fix/x')
    expect(gh.fetchPrHeads).toHaveBeenCalledTimes(2)
  })
})
