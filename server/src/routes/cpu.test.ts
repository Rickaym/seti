import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cpuCapDefaults, type CpuCapSettings, type TaskCpuCap } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { cpuPrompt, effectiveCpuCap, hostMaxPercent } from '../cpu-cap.js'
import { tasks } from '../db.js'
import { planScope } from '../memory-cap.js'
import { auditEvents } from '../store/audit.js'
import { USER_AUTH } from '../test-auth.js'

const TASK = 'cpu-cap-task'
const OTHER = 'cpu-cap-other'
const app = createApp()
const max = hostMaxPercent()
const defaults = cpuCapDefaults(max)

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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-cpu-cap-'))
  for (const id of [TASK, OTHER]) {
    await tasks.insert({ id, title: `Agent ${id}`, repo_id: null, cwd, worktree: false, pr_urls: [] })
  }
})

describe('the CPU cap settings', () => {
  it('starts at three cores or every core, with half the weight of Seti', async () => {
    expect(defaults).toEqual({ quota_percent: Math.min(300, max) })
    expect(cpuCapDefaults(200)).toEqual({ quota_percent: 200 })
    expect(await data<CpuCapSettings>('/resources/cpu')).toEqual({
      cap: defaults,
      defaults,
      enforced: false,
      updated_at: null,
      max_percent: os.availableParallelism() * 100,
      weight: 50,
    })
  })

  it('saves a new default, turns the ceiling off and audits both', async () => {
    const saved = await data<CpuCapSettings>('/resources/cpu', 'PUT', { quota_percent: 50 })
    expect(saved.cap).toEqual({ quota_percent: 50 })
    expect(saved.updated_at).not.toBeNull()
    expect(await effectiveCpuCap(TASK)).toEqual({ quota_percent: 50 })
    await auditEvents.settled()
    expect(await auditEvents.latest('system.cpu_cap_changed')).toMatchObject({
      actor: 'user',
      summary: 'Set the agent CPU cap to 0.5 cores',
      detail: { quota_percent: 50, was_quota_percent: defaults.quota_percent },
    })
    expect((await data<CpuCapSettings>('/resources/cpu', 'PUT', { quota_percent: null })).cap.quota_percent).toBeNull()
    await auditEvents.settled()
    expect((await auditEvents.latest('system.cpu_cap_changed'))?.summary).toBe('Turned the agent CPU cap off')
    await data('/resources/cpu', 'PUT', defaults)
  })

  it('refuses less than half a core, more than the host has, fractions and missing fields', async () => {
    for (const body of [
      { quota_percent: 49 },
      { quota_percent: max + 1 },
      { quota_percent: 150.5 },
      { quota_percent: '300' },
      {},
    ]) {
      expect((await request('/resources/cpu', 'PUT', body)).status).toBe(400)
    }
    expect((await data<CpuCapSettings>('/resources/cpu', 'PUT', { quota_percent: max })).cap.quota_percent).toBe(max)
    await data('/resources/cpu', 'PUT', defaults)
    expect((await data<CpuCapSettings>('/resources/cpu')).cap).toEqual(defaults)
  })
})

describe('the CPU cap of one agent', () => {
  it('overrides the default for that agent only, goes back with null and audits both', async () => {
    const own = { quota_percent: 150 }
    const set = await data<TaskCpuCap>(`/tasks/${TASK}/cpu`, 'PUT', { cap: own })
    expect(set).toEqual({ override: own, effective: own, enforced: false, max_percent: max })
    expect(await effectiveCpuCap(OTHER)).toEqual(defaults)
    await auditEvents.settled()
    expect(await auditEvents.latest('task.cpu_cap_changed')).toMatchObject({
      subject_id: TASK,
      summary: `Gave task "Agent ${TASK}" a CPU cap of its own: 1.5 cores`,
    })

    const off = await data<TaskCpuCap>(`/tasks/${TASK}/cpu`, 'PUT', { cap: { quota_percent: null } })
    expect(off.effective).toEqual({ quota_percent: null })
    await auditEvents.settled()
    expect((await auditEvents.latest('task.cpu_cap_changed'))?.summary).toBe(
      `Turned the CPU cap of task "Agent ${TASK}" off`,
    )

    const cleared = await data<TaskCpuCap>(`/tasks/${TASK}/cpu`, 'PUT', { cap: null })
    expect(cleared).toEqual({ override: null, effective: defaults, enforced: false, max_percent: max })
    expect(await data<TaskCpuCap>(`/tasks/${TASK}/cpu`)).toEqual(cleared)
    await auditEvents.settled()
    expect((await auditEvents.latest('task.cpu_cap_changed'))?.summary).toBe(
      `Gave task "Agent ${TASK}" the default CPU cap`,
    )
  })

  it('refuses a bad cap and an unknown agent, and plans no scope or prompt where the host has none', async () => {
    expect((await request(`/tasks/${TASK}/cpu`, 'PUT', { cap: { quota_percent: 10 } })).status).toBe(400)
    expect((await request(`/tasks/${TASK}/cpu`, 'PUT', { cap: { quota_percent: max + 50 } })).status).toBe(400)
    expect((await request(`/tasks/${TASK}/cpu`, 'PUT', {})).status).toBe(400)
    expect((await request('/tasks/no-such-task/cpu', 'PUT', { cap: null })).status).toBe(404)
    expect(await planScope(TASK, 'agent')).toBeNull()
    expect(await cpuPrompt(TASK)).toBeNull()
  })
})
