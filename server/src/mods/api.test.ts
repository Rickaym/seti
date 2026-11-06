import { sampleServer } from '@seti/mod-sample/server'
import { modManifest, type ModCapabilityName } from '@seti/shared'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cache, redisReady } from '../redis.js'
import { serverApi } from './api.js'
import { BUNDLED_MODS } from './bundled.js'
import { ModHost } from './host.js'
import { modRouteEntries } from './points.js'

vi.hoisted(() => {
  process.env.SETI_REDIS_URL = process.env.SETI_TEST_REDIS_URL ?? '/run/seti-redis/redis.sock'
})

beforeAll(async () => {
  expect(await redisReady(5000)).toBe(true)
})

const probe = (grants: ModCapabilityName[], id = 'probe') =>
  serverApi({
    manifest: { ...modManifest.parse(sampleServer.manifest), id },
    grants,
    track: (dispose) => dispose,
  })

describe('the mod cache', () => {
  it('keeps values under the mod id for as long as asked, with the storage capability', async () => {
    await expect(probe([]).cache.set('k', 1, 60)).rejects.toThrow('The mod probe was not granted storage')
    await probe(['storage']).cache.set('k', { a: 1 }, 60)
    expect(await probe(['storage']).cache.get('k')).toEqual({ a: 1 })
    expect(await cache.get('mod:probe:k')).toEqual({ a: 1 })
    expect(await probe(['storage'], 'other').cache.get('k')).toBeUndefined()
  })

  it('refuses a value that lives too long or weighs too much', async () => {
    await expect(probe(['storage']).cache.set('k', 1, 0)).rejects.toThrow('lives 1 to 86400 seconds')
    await expect(probe(['storage']).cache.set('k', 1, 86_401)).rejects.toThrow('lives 1 to 86400 seconds')
    await expect(probe(['storage']).cache.set('k', 'x'.repeat(300_000), 60)).rejects.toThrow('at most 256 KB')
  })
})

describe('the mod environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("reads only the mod's own SETI_<ID>_ variables", () => {
    vi.stubEnv('SETI_PROBE_URL', 'https://example.com')
    vi.stubEnv('SETI_TWO_PART_URL', 'off')
    vi.stubEnv('SETI_REDIS_URL', 'secret')
    expect(probe([]).env('URL')).toBe('https://example.com')
    expect(probe([], 'two-part').env('URL')).toBe('off')
    expect(probe([]).env('MISSING')).toBeUndefined()
    expect(probe([]).env('../REDIS_URL')).toBeUndefined()
  })
})

describe('the bundled mods', () => {
  it('each with routes turns on with them and off again leaving none, a required one only by stopping', async () => {
    for (const definition of BUNDLED_MODS) {
      const host = new ModHost([{ definition, tier: 'bundled' }])
      const manifest = host.list()[0]?.manifest
      if (!manifest || manifest.contributes.routes.length === 0) {
        continue
      }
      const id = manifest.id
      const routes = () => modRouteEntries.list().filter((route) => route.mod === id)
      await host.setEnabled(id, true)
      expect(routes().length, id).toBeGreaterThan(0)
      if (manifest.required) {
        await expect(host.setEnabled(id, false), id).rejects.toThrow('is part of Seti and always on')
        host.stopAll()
      } else {
        await host.setEnabled(id, false)
      }
      expect(routes(), id).toEqual([])
      await host.setEnabled(id, true)
      expect(routes().length, id).toBeGreaterThan(0)
      host.stopAll()
    }
  })
})
