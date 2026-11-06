import os from 'node:os'
import {
  AGENT_CPU_WEIGHT,
  cpuBudgetLine,
  cpuCapDefaults,
  cpuCapLabel,
  cpuCapProblem,
  type AuditActor,
  type CpuCap,
  type CpuCapSettings,
  type Task,
  type TaskCpuCap,
} from '@seti/shared'
import { audit } from './audit.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { scopeHost } from './memory-scope.js'
import { applyCpuCaps } from './scope-limits.js'
import { cpuSettings, taskCpuCaps } from './store/cpu.js'

/** Every core of this host in percent of one, nproc x 100: the highest cap there is. */
export const hostMaxPercent = () => os.availableParallelism() * 100

const enforced = async () => (await scopeHost())?.cpu === true

async function defaultCap(): Promise<CpuCap> {
  return (await cpuSettings.get())?.cap ?? cpuCapDefaults(hostMaxPercent())
}

/** The CPU cap a task's processes run under: its own, else the default. */
export async function effectiveCpuCap(taskId: string): Promise<CpuCap> {
  return (await taskCpuCaps.get(taskId)) ?? (await defaultCap())
}

/** Tells the agent how many cores it gets, where the host holds it to a ceiling. */
export async function cpuPrompt(taskId: string): Promise<string | null> {
  return (await enforced()) ? cpuBudgetLine(await effectiveCpuCap(taskId)) : null
}

export async function cpuCapSettings(): Promise<CpuCapSettings> {
  const max = hostMaxPercent()
  const saved = await cpuSettings.get()
  return {
    cap: saved?.cap ?? cpuCapDefaults(max),
    defaults: cpuCapDefaults(max),
    enforced: await enforced(),
    updated_at: saved?.updated_at ?? null,
    max_percent: max,
    weight: AGENT_CPU_WEIGHT,
  }
}

function checkFits(cap: CpuCap): void {
  const problem = cpuCapProblem(cap, hostMaxPercent())
  if (problem !== null) {
    throw new HttpError(400, problem)
  }
}

/** Saves the default cap and applies it at once to running agents without a cap of their own. */
export async function updateCpuCap(cap: CpuCap, actor: AuditActor = 'user'): Promise<CpuCapSettings> {
  refuseAgent('change the CPU cap of agents')
  checkFits(cap)
  const before = await defaultCap()
  await cpuSettings.set(cap)
  await audit.record({
    actor,
    kind: 'system.cpu_cap_changed',
    subject_type: 'system',
    summary:
      cap.quota_percent === null ? 'Turned the agent CPU cap off' : `Set the agent CPU cap to ${cpuCapLabel(cap)}`,
    detail: { ...cap, was_quota_percent: before.quota_percent },
  })
  await applyCpuCaps(async (taskId) => ((await taskCpuCaps.get(taskId)) === null ? cap : null))
  return cpuCapSettings()
}

export async function taskCpuCap(taskId: string): Promise<TaskCpuCap> {
  const override = await taskCpuCaps.get(taskId)
  return {
    override,
    effective: override ?? (await defaultCap()),
    enforced: await enforced(),
    max_percent: hostMaxPercent(),
  }
}

function taskSummary(task: Task, cap: CpuCap | null): string {
  if (cap === null) {
    return `Gave task "${task.title}" the default CPU cap`
  }
  if (cap.quota_percent === null) {
    return `Turned the CPU cap of task "${task.title}" off`
  }
  return `Gave task "${task.title}" a CPU cap of its own: ${cpuCapLabel(cap)}`
}

/** Gives the task a cap of its own, or with null the default; its live processes get it at once. */
export async function setTaskCpuCap(task: Task, cap: CpuCap | null, actor: AuditActor = 'user'): Promise<TaskCpuCap> {
  refuseAgent("change an agent's CPU cap")
  if (cap !== null) {
    checkFits(cap)
  }
  await taskCpuCaps.set(task.id, cap)
  const result = await taskCpuCap(task.id)
  await audit.record({
    actor,
    kind: 'task.cpu_cap_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: taskSummary(task, cap),
    detail: { title: task.title, ...result.effective, own: cap !== null },
  })
  await applyCpuCaps(async (taskId) => Promise.resolve(taskId === task.id ? result.effective : null))
  return result
}
