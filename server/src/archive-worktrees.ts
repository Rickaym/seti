import fs from 'node:fs'
import path from 'node:path'
import type { ArchivedWorktree, RestoredWorktree, Task } from '@seti/shared'
import { ensureBundleDir, patchesDir } from './archive-files.js'
import { repos, tasks } from './db.js'
import { directoryBytes, recreateWorktree, removeWorktree, saveUncommitted, worktreeState } from './git.js'
import { HttpError } from './http.js'
import { busyReason, removalRefusal } from './owned-dirs.js'
import { taskArchives } from './store/archive.js'
import { inLane } from './task-lane.js'

type TaskRepo = Task['repos'][number]

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const keptWorktree = (entry: TaskRepo, why: string): ArchivedWorktree => ({
  repo_id: entry.id,
  repo: entry.slug,
  dir: entry.dir,
  removed: false,
  kept_because: why,
  head: null,
  branch: null,
  bytes: null,
})

/** Saves a kept worktree's uncommitted changes as a patch in the task's archive bundle. */
async function savePatch(taskId: string, dir: string): Promise<string | null> {
  try {
    ensureBundleDir(taskId)
    fs.mkdirSync(patchesDir(taskId), { recursive: true, mode: 0o700 })
    const file = path.join(patchesDir(taskId), `${path.basename(dir)}.patch`)
    await saveUncommitted(dir, file)
    return file
  } catch (e) {
    process.stderr.write(`archive: could not save the changes in ${dir}: ${errorText(e)}\n`)
    return null
  }
}

/**
 * Removes a worktree Seti made for the task when it is clean and its commit stays reachable, on
 * its branch or pushed. A dirty one stays, its changes saved as a patch in the archive bundle.
 */
async function freeWorktree(taskId: string, entry: TaskRepo, others: readonly Task[]): Promise<ArchivedWorktree> {
  const repo = await repos.get(entry.id)
  if (!repo) {
    return keptWorktree(entry, 'its repo is no longer registered')
  }
  if (!fs.existsSync(entry.dir)) {
    return keptWorktree(entry, 'it was already gone')
  }
  const refusal = removalRefusal(entry.dir, 'worktrees', others)
  if (refusal !== null) {
    return keptWorktree(entry, refusal)
  }
  const busy = await busyReason(entry.dir)
  if (busy !== null) {
    return { ...keptWorktree(entry, busy), retry: true }
  }
  try {
    const { head, branch, dirty, pushed } = await worktreeState(entry.dir)
    if (dirty) {
      const patch = await savePatch(taskId, entry.dir)
      return { ...keptWorktree(entry, 'it has uncommitted changes'), head, branch, patch }
    }
    if (branch === null && !pushed) {
      return { ...keptWorktree(entry, 'its commit is on no branch and not pushed'), head, branch }
    }
    const bytes = await directoryBytes(entry.dir)
    await removeWorktree(repo.path, entry.dir)
    return { ...keptWorktree(entry, ''), kept_because: null, removed: true, head, branch, bytes }
  } catch (e) {
    return keptWorktree(entry, `it could not be checked: ${errorText(e)}`)
  }
}

/** Frees each worktree Seti made for the task, or keeps them all when asked to. */
export async function freeWorktrees(task: Task, remove: boolean): Promise<ArchivedWorktree[]> {
  const results: ArchivedWorktree[] = []
  const others = (await tasks.listAll()).filter((other) => other.id !== task.id)
  for (const entry of task.repos.filter((repo) => repo.worktree)) {
    results.push(remove ? await freeWorktree(task.id, entry, others) : keptWorktree(entry, 'kept as asked'))
  }
  return results
}

/** Tries again to free the worktrees an archive kept only because a process worked in them. */
export async function retryArchivedWorktrees(taskId: string): Promise<void> {
  await inLane(taskId, async () => {
    const [task, record] = await Promise.all([tasks.get(taskId), taskArchives.get(taskId)])
    const waiting = record?.worktrees.some((worktree) => worktree.retry === true) ?? false
    if (task === undefined || record === undefined || !waiting) {
      return
    }
    if (task.archived_at === null) {
      return
    }
    const others = (await tasks.listAll()).filter((other) => other.id !== task.id)
    const next: ArchivedWorktree[] = []
    for (const worktree of record.worktrees) {
      const entry = task.repos.find((repo) => repo.dir === worktree.dir && repo.worktree)
      next.push(worktree.retry === true && entry !== undefined ? await freeWorktree(task.id, entry, others) : worktree)
    }
    await taskArchives.setWorktrees(task.id, next)
  })
}

interface Recreated {
  restored: RestoredWorktree[]
  undo: () => Promise<void>
}

/** Checks removed worktrees out again; on a failure removes those it made and refuses. */
export async function recreateWorktrees(worktrees: readonly ArchivedWorktree[]): Promise<Recreated> {
  const restored: RestoredWorktree[] = []
  const made: { repoPath: string; dir: string }[] = []
  const undo = async () => {
    await Promise.allSettled(made.map(async ({ repoPath, dir }) => removeWorktree(repoPath, dir)))
  }
  try {
    for (const worktree of worktrees) {
      const needed = worktree.removed && !fs.existsSync(worktree.dir)
      if (needed) {
        const repo = await repos.get(worktree.repo_id)
        if (repo === undefined || worktree.head === null) {
          throw new Error(`the repo ${worktree.repo} is no longer registered`)
        }
        await recreateWorktree(repo.path, worktree.dir, worktree.branch, worktree.head)
        made.push({ repoPath: repo.path, dir: worktree.dir })
      }
      restored.push({ repo: worktree.repo, dir: worktree.dir, recreated: needed })
    }
  } catch (e) {
    await undo()
    throw new HttpError(409, `Could not recreate the worktree: ${errorText(e)}`)
  }
  return { restored, undo }
}
