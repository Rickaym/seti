import { setTimeout as sleep } from 'node:timers/promises'
import type { TaskEvent } from '@seti/shared'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { broadcast, redisReady } from './redis.js'
import { publish, relayTaskEvents, subscribe } from './task-events.js'

vi.hoisted(() => {
  process.env.SETI_REDIS_URL = process.env.SETI_TEST_REDIS_URL ?? '/run/seti-redis/redis.sock'
})

beforeAll(async () => {
  expect(await redisReady(5000)).toBe(true)
  relayTaskEvents()
})

describe('task events across processes', () => {
  it('hands streams the events another process publishes', async () => {
    const seen: TaskEvent[] = []
    subscribe('relay-1', (event) => seen.push(event))
    const foreign: TaskEvent = { type: 'status', status: 'idle' }
    await vi.waitFor(async () => {
      await broadcast('task:relay-1', JSON.stringify({ origin: 'another-process', event: foreign }))
      expect(seen).toContainEqual(foreign)
    })
  })

  it('delivers this process own events once, not again through Redis', async () => {
    const seen: TaskEvent[] = []
    subscribe('relay-2', (event) => seen.push(event))
    publish('relay-2', { type: 'status', status: 'running' })
    expect(seen).toEqual([{ type: 'status', status: 'running' }])
    await sleep(200)
    expect(seen).toHaveLength(1)
  })

  it('keeps events of other tasks apart', async () => {
    const seen: TaskEvent[] = []
    subscribe('relay-3', (event) => seen.push(event))
    await broadcast('task:relay-4', JSON.stringify({ origin: 'another-process', event: { type: 'prs' } }))
    await sleep(200)
    expect(seen).toEqual([])
  })
})
