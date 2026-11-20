import fs from 'node:fs'
import type { AgentStorage, AgentStorageState, DiskSpace, FolderSize, StorageOverview, Task } from '@seti/shared'
import { SCRATCH_ROOT, SETI_HOME } from './config.js'
import { tasks } from './db.js'
import { isRunning } from './runner.js'
import { BackgroundMemo, bySize, cachedSize, measuring } from './size-cache.js'
import { planClean } from './storage-clean.js'
import { agentFolders } from './storage-folders.js'
import { findOrphans, publicOrphan, workNow, type WorkCheck } from './storage-orphans.js'
import { storageSettings } from './store/storage.js'
import { taskLocation } from './store/task-location.js'

const PLAN_TTL_MS = 10 * 60_000
const WORK_CHECK_TTL_MS = 2 * 60_000

/** Each agent's rebuildable folders, worked out in the background, since that walks and runs git. */
const plans = new BackgroundMemo<string[]>('plan', PLAN_TTL_MS)
/** Whether an orphan holds work git has not saved, checked in the background since it runs git. */
const workChecks = new BackgroundMemo<{ reason: string | null }>('work', WORK_CHECK_TTL_MS)

const cachedWork: WorkCheck = async (dir) =>
  Promise.resolve(
    workChecks.get(dir, async () => ({ reason: await workNow(dir) }))?.reason ??
      (workChecks.has(dir) ? null : 'it is being checked for unsaved work'),
  )

/** Drops what a removal made wrong, so the next read works it out again. */
export function forgetStorage(taskId: string): void {
  plans.forget(taskId)
}

/** The sum of sizes, "about" when any was capped or is not measured yet; null when none is. */
export function sumSizes(sizes: readonly (FolderSize | null)[]): FolderSize | null {
  const known = sizes.filter((size) => size !== null)
  if (known.length === 0 && sizes.length > 0) {
    return null
  }
  return {
    bytes: known.reduce((sum, size) => sum + size.bytes, 0),
    files: known.reduce((sum, size) => sum + size.files, 0),
    capped: known.length < sizes.length || known.some((size) => size.capped),
  }
}

function stateOf(task: Task): AgentStorageState {
  if (task.archived_at !== null) {
    return 'archived'
  }
  return task.status === 'running' || isRunning(task.id) ? 'running' : 'idle'
}

async function agentStorage(task: Task, worktreeDirs: readonly string[]): Promise<AgentStorage> {
  const folders = (await agentFolders(task, worktreeDirs)).map((folder) => ({
    kind: folder.kind,
    path: folder.path,
    size: cachedSize(folder.path),
    owned: folder.owned !== null,
  }))
  const targets = plans.get(task.id, async () => (await planClean(task)).plan.targets.map((target) => target.dir))
  const rebuildable = targets === null ? null : sumSizes(targets.map((dir) => cachedSize(dir)))
  return {
    task_id: task.id,
    title: task.title,
    state: stateOf(task),
    last_activity: task.updated_at,
    size: sumSizes(folders.map((folder) => folder.size)),
    rebuildable_bytes: targets !== null && targets.length === 0 ? 0 : (rebuildable?.bytes ?? null),
    folders,
  }
}

async function diskSpace(): Promise<DiskSpace | null> {
  const where = fs.existsSync(SCRATCH_ROOT) ? SCRATCH_ROOT : SETI_HOME
  try {
    const stats = await fs.promises.statfs(where)
    return { path: where, total_bytes: stats.blocks * stats.bsize, free_bytes: stats.bavail * stats.bsize }
  } catch {
    return null
  }
}

/** Every agent's folders with sizes, the orphans and the disk, from what is measured so far. */
export async function storageOverview(): Promise<StorageOverview> {
  const worktrees = await taskLocation.worktreeDirsByTask()
  const agents = await Promise.all(
    (await tasks.listAll()).map(async (task) => agentStorage(task, worktrees.get(task.id) ?? [])),
  )
  agents.sort((a, b) => {
    const order = bySize(a.size, b.size)
    return order !== 0 ? order : a.title.localeCompare(b.title)
  })
  const orphans = (await findOrphans(cachedWork)).map(publicOrphan)
  const counted = new Map<string, number>()
  for (const folder of agents.flatMap((agent) => agent.folders)) {
    counted.set(folder.path, folder.size?.bytes ?? 0)
  }
  for (const orphan of orphans) {
    counted.set(orphan.path, orphan.size?.bytes ?? 0)
  }
  return {
    disk: await diskSpace(),
    total_bytes: [...counted.values()].reduce((sum, bytes) => sum + bytes, 0),
    rebuildable_bytes: agents.reduce((sum, agent) => sum + (agent.rebuildable_bytes ?? 0), 0),
    agents,
    orphans,
    measuring: measuring(),
    schedule: await storageSettings.get(),
  }
}
