import path from 'node:path'
import type { CleanPlan, CleanTarget, RemovalResult, Task } from '@seti/shared'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { removeNestedDir, type NestedIn } from './owned-dirs.js'
import { findCandidates, judgeCandidates } from './rebuildable.js'
import { isRunning, sessionState } from './runner.js'
import { cachedSize, forgetSizes, freshSize, measuring } from './size-cache.js'
import { agentFolders } from './storage-folders.js'

/** How many removals one audit event lists by path; the count and bytes cover the rest. */
const AUDIT_FOLDERS_MAX = 50

/** Why Clean must leave the agent alone now: it runs a turn or background work; else null. */
export function cleanRefusal(task: Task): string | null {
  if (task.status === 'running' || isRunning(task.id) || sessionState(task.id).background > 0) {
    return `Agent "${task.title}" is running; Clean waits until it stops`
  }
  return null
}

interface Planned {
  plan: CleanPlan
  /** The agent folder each target lies in. */
  bases: Map<string, NestedIn>
}

/** The rebuildable folders Clean would remove from the folders Seti made for the agent. */
export async function planClean(task: Task): Promise<Planned> {
  const plan: CleanPlan = {
    task_id: task.id,
    title: task.title,
    targets: [],
    bytes: 0,
    refused: cleanRefusal(task),
    kept: [],
    measuring: false,
  }
  const bases = new Map<string, NestedIn>()
  for (const folder of await agentFolders(task)) {
    if (folder.owned === null) {
      continue
    }
    const { candidates, capped } = findCandidates(folder.owned)
    const judged = await judgeCandidates(folder.owned.base, candidates)
    plan.kept.push(...judged.kept)
    if (capped) {
      plan.kept.push({ dir: folder.path, reason: 'it holds too many folders to look through all of them' })
    }
    for (const dir of judged.targets) {
      bases.set(dir, folder.owned)
      const bytes = cachedSize(dir)?.bytes ?? null
      plan.targets.push({ dir, base: folder.owned.base, path: path.relative(folder.owned.base, dir), bytes })
    }
  }
  plan.targets.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  plan.bytes = plan.targets.reduce((sum, target) => sum + (target.bytes ?? 0), 0)
  plan.measuring = plan.targets.some((target) => target.bytes === null) && measuring()
  return { plan, bases }
}

export interface CleanOptions {
  actor: 'user' | 'system'
  /** Only these folders, as the plan the caller saw named them; all planned ones when left out. */
  dirs?: readonly string[]
  /** Why the system cleaned, for its audit event. */
  reason?: string
}

async function removeTargets(task: Task, planned: Planned, wanted: ReadonlySet<string> | null): Promise<RemovalResult> {
  const others = (await tasks.listAll()).filter((other) => other.id !== task.id)
  const result: RemovalResult = { removed: [], refused: [], freed_bytes: 0 }
  const plannedDirs = new Set(planned.plan.targets.map((target) => target.dir))
  for (const dir of wanted ?? plannedDirs) {
    const inside = planned.bases.get(dir)
    if (inside === undefined || !plannedDirs.has(dir)) {
      result.refused.push({ path: dir, reason: 'it is not a rebuildable folder of this agent now' })
      continue
    }
    const bytes = (await freshSize(dir)).bytes
    const refusal = await removeNestedDir(dir, inside, others).catch((e: unknown) =>
      e instanceof Error ? e.message : String(e),
    )
    if (refusal !== null) {
      result.refused.push({ path: dir, reason: refusal })
      continue
    }
    forgetSizes(dir)
    result.removed.push({ path: dir, bytes })
    result.freed_bytes += bytes
  }
  return result
}

async function auditClean(task: Task, planned: Planned, result: RemovalResult, options: CleanOptions) {
  const target = new Map(planned.plan.targets.map((entry): [string, CleanTarget] => [entry.dir, entry]))
  const folders = result.removed.slice(0, AUDIT_FOLDERS_MAX).map((removed) => {
    const entry = target.get(removed.path)
    const where = entry === undefined ? removed.path : `${entry.path} in ${entry.base}`
    return `${where}: ${String(removed.bytes ?? 0)} bytes`
  })
  const via = options.reason === undefined ? '' : ` (${options.reason})`
  return audit.record({
    actor: options.actor,
    kind: 'task.storage_cleaned',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Cleaned ${String(result.removed.length)} rebuildable folder(s) of agent "${task.title}", ${String(result.freed_bytes)} bytes${via}`,
    detail: {
      title: task.title,
      folders,
      removed: result.removed.length,
      freed_bytes: result.freed_bytes,
      refused: result.refused.length,
    },
  })
}

/**
 * Removes the agent's rebuildable folders the plan names now, each checked again just before, and
 * audits each one with its folder, its path there and the bytes it freed. Refused while it runs.
 */
export async function cleanAgent(task: Task, options: CleanOptions): Promise<RemovalResult> {
  refuseAgent("clean agents' folders")
  const refusal = cleanRefusal(task)
  if (refusal !== null) {
    throw new HttpError(409, refusal)
  }
  const planned = await planClean(task)
  const result = await removeTargets(task, planned, options.dirs === undefined ? null : new Set(options.dirs))
  if (result.removed.length > 0) {
    await auditClean(task, planned, result, options)
  }
  return result
}
