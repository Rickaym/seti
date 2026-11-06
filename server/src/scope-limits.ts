import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { AGENT_CPU_WEIGHT, type CpuCap, type CpuScope, type MemoryCap, type MemoryScope } from '@seti/shared'
import { capProperties, isLive, liveScopes, parseEvents, userBus, type ScopeLimits } from './memory-scope.js'
import { CpuSampler, cpuProperties, parseCpuStat } from './scope-cpu.js'

const run = promisify(execFile)

const MB = 1024 * 1024

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const readBytes = (dir: string, file: string) => {
  const value = Number((readText(path.join(dir, file)) ?? '0').trim())
  return Number.isFinite(value) ? value : 0
}

type FoundScope = ScopeLimits & { dir: string }

const ofTask = (taskId: string) =>
  liveScopes().filter((scope): scope is FoundScope => scope.plan.taskId === taskId && scope.dir !== null)

export function scopeMemory(taskId: string): MemoryScope[] {
  return ofTask(taskId).map((scope) => {
    const events = parseEvents(readText(path.join(scope.dir, 'memory.events')) ?? '')
    return {
      unit: scope.unit,
      kind: scope.plan.kind,
      current_bytes: readBytes(scope.dir, 'memory.current'),
      swap_bytes: readBytes(scope.dir, 'memory.swap.current'),
      high_bytes: scope.cap.high_mb * MB,
      max_bytes: scope.cap.max_mb * MB,
      swap_max_bytes: scope.cap.swap_max_mb * MB,
      oom_kills: events.oom_kill,
      high_events: events.high,
    }
  })
}

const sampler = new CpuSampler((dir) => {
  const text = readText(path.join(dir, 'cpu.stat'))
  return text === null ? null : parseCpuStat(text)
})

async function cpuOf(scope: FoundScope): Promise<CpuScope[]> {
  const used = await sampler.sample(scope.unit, scope.dir)
  if (used === null) {
    return []
  }
  const { quota_percent } = scope.cpu
  return [{ unit: scope.unit, kind: scope.plan.kind, quota_percent, weight: AGENT_CPU_WEIGHT, ...used }]
}

/** The task's scopes' CPU use against their ceiling; none where the cpu controller is missing. */
export async function scopeCpu(taskId: string): Promise<CpuScope[]> {
  sampler.keep(new Set(liveScopes().map((scope) => scope.unit)))
  const read = await Promise.all(ofTask(taskId).flatMap((scope) => (scope.plan.host.cpu ? [cpuOf(scope)] : [])))
  return read.flat()
}

/** Sets properties of a running scope; false when systemd refused or the scope went away. */
async function setProperties(scope: ScopeLimits, properties: readonly string[], what: string): Promise<boolean> {
  const args = ['--user', 'set-property', '--runtime', scope.unit, ...properties]
  try {
    await run(scope.plan.host.systemctl, args, userBus(scope.plan.host))
    return true
  } catch (e) {
    if (isLive(scope.unit)) {
      process.stderr.write(`${what}: could not change the cap of ${scope.unit}: ${String(e)}\n`)
    }
    return false
  }
}

const sameCap = (a: MemoryCap, b: MemoryCap) =>
  a.high_mb === b.high_mb && a.max_mb === b.max_mb && a.swap_max_mb === b.swap_max_mb

/** Moves the live scopes of the tasks `capOf` covers to their cap now; null leaves a task alone. */
export async function applyCaps(capOf: (taskId: string) => Promise<MemoryCap | null>): Promise<void> {
  for (const scope of liveScopes()) {
    const cap = await capOf(scope.plan.taskId)
    if (cap !== null && !sameCap(cap, scope.cap) && (await setProperties(scope, capProperties(cap), 'memory'))) {
      scope.cap = cap
    }
  }
}

/** Moves the live scopes of the tasks `capOf` covers to their CPU cap now, where the host has one. */
export async function applyCpuCaps(capOf: (taskId: string) => Promise<CpuCap | null>): Promise<void> {
  for (const scope of liveScopes().filter((live) => live.plan.host.cpu)) {
    const cap = await capOf(scope.plan.taskId)
    const changed = cap !== null && cap.quota_percent !== scope.cpu.quota_percent
    if (changed && (await setProperties(scope, cpuProperties(cap), 'cpu'))) {
      scope.cpu = cap
    }
  }
}
