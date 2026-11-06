import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { MEMORY_CAP_DEFAULTS } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { detectScopeHost, launch, liveScopes, scopeArgs } from './memory-scope.js'
import { CpuSampler, cpuProperties, cpuUsage, parseCpuStat, type CpuStat } from './scope-cpu.js'
import { applyCpuCaps, scopeCpu } from './scope-limits.js'

/** cpu.stat of a scope held at a 3-core ceiling that the kernel paused 42 times. */
const CPU_STAT = [
  'usage_usec 9061234',
  'user_usec 8000000',
  'system_usec 1061234',
  'core_sched.force_idle_usec 0',
  'nr_periods 1200',
  'nr_throttled 42',
  'throttled_usec 3150000',
  'nr_bursts 0',
  'burst_usec 0',
  '',
].join('\n')

describe('CPU limits of a scope', () => {
  it('gives every scope a weight below Seti and a ceiling in percent, or none', () => {
    expect(cpuProperties({ quota_percent: 300 })).toEqual(['CPUWeight=50', 'CPUQuota=300%'])
    expect(cpuProperties({ quota_percent: 50 })).toEqual(['CPUWeight=50', 'CPUQuota=50%'])
    expect(cpuProperties({ quota_percent: null })).toEqual(['CPUWeight=50', 'CPUQuota='])
  })

  it('starts a scope with its CPU limits where the host has the cpu controller, and none without', () => {
    const scope = { unit: 'u.scope', cap: MEMORY_CAP_DEFAULTS, bindTo: null }
    const capped = scopeArgs({ ...scope, cpu: { quota_percent: 300 } }, 'true', [])
    expect(capped.slice(5, 13)).toEqual([
      '-p',
      'MemoryHigh=infinity',
      '-p',
      'MemoryMax=6144M',
      '-p',
      'MemorySwapMax=1024M',
      '-p',
      'CPUWeight=50',
    ])
    expect(capped).toContain('CPUQuota=300%')
    expect(scopeArgs({ ...scope, cpu: null }, 'true', []).some((arg) => arg.startsWith('CPU'))).toBe(false)
  })

  it('reads usage and throttling from cpu.stat, and zero from what it cannot read', () => {
    expect(parseCpuStat(CPU_STAT)).toEqual({ usage_usec: 9_061_234, nr_throttled: 42, throttled_usec: 3_150_000 })
    expect(parseCpuStat('')).toEqual({ usage_usec: 0, nr_throttled: 0, throttled_usec: 0 })
    expect(parseCpuStat('usage_usec NaN\nnr_throttled 3')).toEqual({
      usage_usec: 0,
      nr_throttled: 3,
      throttled_usec: 0,
    })
  })

  it('measures percent of one core between two readings, and whether the kernel paused it', () => {
    const before = { stat: parseCpuStat(CPU_STAT), at: 1000 }
    const busy = { usage_usec: 9_061_234 + 750_000, nr_throttled: 45, throttled_usec: 3_400_000 }
    expect(cpuUsage(before, { stat: busy, at: 1250 })).toEqual({ usage_percent: 300, throttled_now: true })
    const idle = { ...before.stat, usage_usec: before.stat.usage_usec + 2500 }
    expect(cpuUsage(before, { stat: idle, at: 2000 })).toEqual({ usage_percent: 0.3, throttled_now: false })
  })

  it('measures a first look over a short window and later looks from the one before', async () => {
    const looks = [
      { at: 0, usage: 0 },
      { at: 250, usage: 250_000 },
      { at: 1250, usage: 750_000 },
      { at: 20_000, usage: 900_000 },
      { at: 20_250, usage: 1_150_000 },
    ]
    let now = 0
    const read = vi.fn((): CpuStat => {
      const look = looks.shift() ?? { at: now, usage: 0 }
      now = look.at
      return { usage_usec: look.usage, nr_throttled: 0, throttled_usec: 0 }
    })
    const sampler = new CpuSampler(read, 0, () => now)
    expect(await sampler.sample('a.scope', '/a')).toMatchObject({ usage_percent: 100 })
    expect(read).toHaveBeenCalledTimes(2)
    now = 1250
    expect(await sampler.sample('a.scope', '/a')).toMatchObject({ usage_percent: 50, usage_usec: 750_000 })
    expect(read).toHaveBeenCalledTimes(3)
    now = 20_000
    expect(await sampler.sample('a.scope', '/a')).toMatchObject({ usage_percent: 100 })
    expect(read).toHaveBeenCalledTimes(5)
    sampler.keep(new Set())
    await sampler.sample('a.scope', '/a')
    expect(read).toHaveBeenCalledTimes(7)
  })

  it('reads nothing of a scope whose cpu.stat is gone', async () => {
    const sampler = new CpuSampler(() => null, 0)
    expect(await sampler.sample('gone.scope', '/gone')).toBeNull()
    expect(await scopeCpu('no-such-task')).toEqual([])
  })
})

const host = await detectScopeHost(true)
const cpuHost = host?.cpu === true ? host : null

describe.skipIf(cpuHost === null)('CPU limits of a scope on this host', () => {
  it('starts a scope at its ceiling and weight, and moves it to a new ceiling and to none', async ({ skip }) => {
    if (cpuHost === null) {
      skip()
      return
    }
    const taskId = 'cpu-scope-apply'
    const plan = {
      host: cpuHost,
      taskId,
      kind: 'shell' as const,
      cap: MEMORY_CAP_DEFAULTS,
      cpu: { quota_percent: 300 },
    }
    const child = launch(plan, process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], (command, args) =>
      spawn(command, args, { env: { ...process.env, XDG_RUNTIME_DIR: cpuHost.runtimeDir }, stdio: 'ignore' }),
    )
    const cpuFile = (file: string) => {
      const dir = liveScopes().find((scope) => scope.plan.taskId === taskId)?.dir ?? null
      return dir === null ? null : fs.readFileSync(path.join(dir, file), 'utf8').trim()
    }
    try {
      await vi.waitFor(() => {
        expect(cpuFile('cpu.max')).toBe('300000 100000')
      })
      expect(cpuFile('cpu.weight')).toBe('50')
      const [scope] = await scopeCpu(taskId)
      expect(scope).toMatchObject({ kind: 'shell', quota_percent: 300, weight: 50, throttled_now: false })
      expect(scope?.usage_percent).toBeLessThan(100)

      await applyCpuCaps(async (id) => Promise.resolve(id === taskId ? { quota_percent: 150 } : null))
      expect(cpuFile('cpu.max')).toBe('150000 100000')
      await applyCpuCaps(async (id) => Promise.resolve(id === taskId ? { quota_percent: null } : null))
      expect(cpuFile('cpu.max')).toBe('max 100000')
      expect((await scopeCpu(taskId))[0]?.quota_percent).toBeNull()
    } finally {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  })
})
