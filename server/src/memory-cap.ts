import {
  capLabel,
  MEMORY_CAP_DEFAULTS,
  memoryBudgetLine,
  type AuditActor,
  type MemoryCap,
  type MemoryCapSettings,
  type Task,
  type TaskMemoryCap,
} from '@seti/shared'
import { audit } from './audit.js'
import { effectiveCpuCap } from './cpu-cap.js'
import { refuseAgent } from './ea-guard.js'
import { scopeHost, type ScopeKind, type ScopePlan } from './memory-scope.js'
import { agentHeapMb } from './node-heap.js'
import { applyCaps } from './scope-limits.js'
import { memorySettings, taskMemoryCaps } from './store/memory.js'

/** The cap a task's processes run under: its own, else the default. */
export async function effectiveCap(taskId: string): Promise<MemoryCap> {
  return (await taskMemoryCaps.get(taskId)) ?? (await memorySettings.get()).cap
}

/** How to start a task's process tree in a scope held to its caps; null where the host has none. */
export async function planScope(taskId: string, kind: ScopeKind): Promise<ScopePlan | null> {
  const host = await scopeHost()
  return host === null
    ? null
    : { host, taskId, kind, cap: await effectiveCap(taskId), cpu: await effectiveCpuCap(taskId) }
}

/** Tells the agent its memory cap and how to size its tools under it, where the host holds one. */
export async function memoryPrompt(taskId: string): Promise<string | null> {
  const cap = (await planScope(taskId, 'agent'))?.cap ?? null
  return cap === null ? null : memoryBudgetLine(cap, agentHeapMb(cap))
}

export async function memoryCapSettings(): Promise<MemoryCapSettings> {
  const { cap, updated_at } = await memorySettings.get()
  return { cap, defaults: MEMORY_CAP_DEFAULTS, enforced: (await scopeHost()) !== null, updated_at }
}

/** Saves the default cap and applies it at once to running agents without a cap of their own. */
export async function updateMemoryCap(cap: MemoryCap, actor: AuditActor = 'user'): Promise<MemoryCapSettings> {
  refuseAgent('change the memory cap of agents')
  const before = (await memorySettings.get()).cap
  await memorySettings.set(cap)
  await audit.record({
    actor,
    kind: 'system.memory_cap_changed',
    subject_type: 'system',
    summary: `Set the agent memory cap to ${capLabel(cap)}`,
    detail: {
      ...cap,
      was_high_mb: before.high_mb,
      was_max_mb: before.max_mb,
      was_swap_max_mb: before.swap_max_mb,
    },
  })
  await applyCaps(async (taskId) => ((await taskMemoryCaps.get(taskId)) === null ? cap : null))
  return memoryCapSettings()
}

export async function taskMemoryCap(taskId: string): Promise<TaskMemoryCap> {
  const override = await taskMemoryCaps.get(taskId)
  return {
    override,
    effective: override ?? (await memorySettings.get()).cap,
    enforced: (await scopeHost()) !== null,
  }
}

/** Gives the task a cap of its own, or with null the default; its live processes get it at once. */
export async function setTaskMemoryCap(
  task: Task,
  cap: MemoryCap | null,
  actor: AuditActor = 'user',
): Promise<TaskMemoryCap> {
  refuseAgent("change an agent's memory cap")
  await taskMemoryCaps.set(task.id, cap)
  const result = await taskMemoryCap(task.id)
  await audit.record({
    actor,
    kind: 'task.memory_cap_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary:
      cap === null
        ? `Gave task "${task.title}" the default memory cap`
        : `Gave task "${task.title}" a memory cap of its own: ${capLabel(cap)}`,
    detail: { title: task.title, ...result.effective, own: cap !== null },
  })
  await applyCaps(async (taskId) => Promise.resolve(taskId === task.id ? result.effective : null))
  return result
}
