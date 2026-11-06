import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MEMORY_CAP_DEFAULTS, type MemoryCapSettings, type TaskMemoryCap } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { effectiveCap, planScope } from '../memory-cap.js'
import { auditEvents } from '../store/audit.js'
import { USER_AUTH } from '../test-auth.js'

const TASK = 'memory-cap-task'
const OTHER = 'memory-cap-other'
const app = createApp()

const request = async (route: string, method = 'GET', body?: unknown) =>
  app.request(`/api${route}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function data<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await request(route, method, body)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

beforeAll(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-memory-cap-'))
  for (const id of [TASK, OTHER]) {
    await tasks.insert({ id, title: `Agent ${id}`, repo_id: null, cwd, worktree: false, pr_urls: [] })
  }
})

describe('the memory cap settings', () => {
  it('starts at the defaults, saves a new default and audits it', async () => {
    const initial = await data<MemoryCapSettings>('/resources/memory')
    expect(initial).toEqual({
      cap: { high_mb: 6144, max_mb: 6144, swap_max_mb: 1024 },
      defaults: MEMORY_CAP_DEFAULTS,
      enforced: false,
      updated_at: null,
    })
    const cap = { high_mb: 3072, max_mb: 5120, swap_max_mb: 512 }
    const saved = await data<MemoryCapSettings>('/resources/memory', 'PUT', cap)
    expect(saved.cap).toEqual(cap)
    expect(saved.updated_at).not.toBeNull()
    expect(await effectiveCap(TASK)).toEqual(cap)
    await auditEvents.settled()
    expect(await auditEvents.latest('system.memory_cap_changed')).toMatchObject({
      actor: 'user',
      summary: 'Set the agent memory cap to 5 GB RAM, soft cap at 3 GB, 512 MB swap',
      detail: { max_mb: 5120, was_max_mb: 6144 },
    })
    await data('/resources/memory', 'PUT', MEMORY_CAP_DEFAULTS)
    await auditEvents.settled()
    expect((await auditEvents.latest('system.memory_cap_changed'))?.summary).toBe(
      'Set the agent memory cap to 6 GB RAM, 1 GB swap',
    )
  })

  it('refuses a cap below 256 MB, a throttle point above the cap and missing fields', async () => {
    for (const body of [
      { high_mb: 128, max_mb: 128, swap_max_mb: 0 },
      { high_mb: 8192, max_mb: 6144, swap_max_mb: 0 },
      { high_mb: 4096, max_mb: 6144, swap_max_mb: -1 },
      { high_mb: 4096.5, max_mb: 6144, swap_max_mb: 0 },
      { max_mb: 6144 },
    ]) {
      expect((await request('/resources/memory', 'PUT', body)).status).toBe(400)
    }
    expect((await data<MemoryCapSettings>('/resources/memory')).cap).toEqual(MEMORY_CAP_DEFAULTS)
  })
})

describe('the memory cap of one agent', () => {
  it('overrides the default for that agent only, goes back with null and audits both', async () => {
    const own = { high_mb: 8192, max_mb: 12288, swap_max_mb: 0 }
    const set = await data<TaskMemoryCap>(`/tasks/${TASK}/memory`, 'PUT', { cap: own })
    expect(set).toEqual({ override: own, effective: own, enforced: false })
    expect(await effectiveCap(OTHER)).toEqual(MEMORY_CAP_DEFAULTS)
    await auditEvents.settled()
    expect(await auditEvents.latest('task.memory_cap_changed')).toMatchObject({
      subject_id: TASK,
      summary: `Gave task "Agent ${TASK}" a memory cap of its own: 12 GB RAM, soft cap at 8 GB, 0 MB swap`,
    })

    const cleared = await data<TaskMemoryCap>(`/tasks/${TASK}/memory`, 'PUT', { cap: null })
    expect(cleared).toEqual({ override: null, effective: MEMORY_CAP_DEFAULTS, enforced: false })
    expect(await data<TaskMemoryCap>(`/tasks/${TASK}/memory`)).toEqual(cleared)
    await auditEvents.settled()
    expect((await auditEvents.latest('task.memory_cap_changed'))?.summary).toBe(
      `Gave task "Agent ${TASK}" the default memory cap`,
    )
  })

  it('refuses a bad cap and an unknown agent, and plans no scope where the host has none', async () => {
    expect((await request(`/tasks/${TASK}/memory`, 'PUT', { cap: { high_mb: 1 } })).status).toBe(400)
    expect((await request(`/tasks/${TASK}/memory`, 'PUT', {})).status).toBe(400)
    expect((await request('/tasks/no-such-task/memory', 'PUT', { cap: null })).status).toBe(404)
    expect(await planScope(TASK, 'agent')).toBeNull()
  })
})
