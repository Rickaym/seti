import type { ArchiveExpiryResult, Task } from '@seti/shared'
import { bundleTaskFiles, removeTaskFiles } from './archive-files.js'
import { retryArchivedWorktrees } from './archive-worktrees.js'
import { expiredArchives } from './archive.js'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { hasLocalChanges } from './git.js'
import { sessionState } from './runner.js'
import { archiveSettings, taskArchives } from './store/archive.js'
import { taskLocation } from './store/task-location.js'
import { forgetSubtasks } from './subtask-cache.js'

const DAY_MS = 24 * 60 * 60 * 1000
const LIFECYCLE_MS = 60 * 60 * 1000
const LIFECYCLE_DELAY_MS = 2 * 60 * 1000

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Deleting a task removes every worktree Seti made for it, so any of them may hold unsaved work. */
async function uncommittedWork(task: Task): Promise<boolean> {
  const worktrees = await taskLocation.worktrees(task.id)
  const dirty = await Promise.all(worktrees.map(async (worktree) => hasLocalChanges(worktree.dir)))
  return dirty.some(Boolean)
}

/** Deletes a task with its files as the system, recording why. */
async function disposeTask(task: Task, summary: string, detail: Record<string, unknown>): Promise<void> {
  await removeTaskFiles(task)
  await tasks.remove(task.id)
  forgetSubtasks(task.id)
  await audit.record({
    actor: 'system',
    kind: 'task.deleted',
    subject_type: 'task',
    subject_id: task.id,
    summary,
    detail: { title: task.title, ...detail },
  })
}

/** An unpinned task no turn, session or background work touched since the cutoff. */
const idleSince = (task: Task, cutoff: string) =>
  !task.pinned && task.updated_at < cutoff && task.status !== 'running' && !sessionState(task.id).open

/** Deletes tasks idle for `days` days with transcripts and worktrees; unsaved work keeps its task. */
export async function disposeIdleTasks(days: number, at: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(at.getTime() - days * DAY_MS).toISOString()
  const disposed: string[] = []
  for (const task of (await tasks.listAll()).filter((candidate) => idleSince(candidate, cutoff))) {
    if (await uncommittedWork(task)) {
      process.stdout.write(`retention: kept task ${task.id}, its worktree has uncommitted changes\n`)
      continue
    }
    await disposeTask(task, `Deleted task "${task.title}" after ${String(days)} days without activity`, {
      reason: 'retention',
      retention_days: days,
    })
    disposed.push(task.id)
  }
  return disposed
}

export function startTaskRetention(days: number | null): void {
  if (days === null) {
    return
  }
  const run = () => {
    disposeIdleTasks(days).catch((e: unknown) => {
      process.stderr.write(`retention: could not dispose of idle tasks: ${errorText(e)}\n`)
    })
  }
  run()
  setInterval(run, DAY_MS).unref()
}

/** Deletes archived agents past the delete rule; unsaved work in a worktree keeps its agent. */
async function expireArchived(at = Date.now()): Promise<ArchiveExpiryResult> {
  const { delete_after_days: days } = await archiveSettings.get()
  const result: ArchiveExpiryResult = { deleted: [], kept: [] }
  for (const task of await expiredArchives(days, at)) {
    if (await uncommittedWork(task)) {
      result.kept.push({ task_id: task.id, reason: 'a worktree has uncommitted changes' })
      continue
    }
    const summary = `Deleted archived agent "${task.title}" after ${String(days)} days in the archive`
    await disposeTask(task, summary, { reason: 'archive_expired', delete_after_days: days })
    result.deleted.push({ task_id: task.id, title: task.title })
  }
  return result
}

/**
 * The archive's upkeep: packs the folders of archived agents that wait for it, frees worktrees a
 * process held at archive time, then deletes archived agents past the delete rule.
 */
export async function sweepArchiveLifecycle(at = Date.now()): Promise<ArchiveExpiryResult> {
  for (const [taskId, record] of await taskArchives.list()) {
    if (record.files === null || record.files.state === 'pending') {
      await bundleTaskFiles(taskId)
    }
    await retryArchivedWorktrees(taskId)
  }
  return expireArchived(at)
}

let lifecycle: Promise<ArchiveExpiryResult> | null = null

export function startArchiveLifecycle(): void {
  const run = () => {
    lifecycle ??= sweepArchiveLifecycle()
      .catch((e: unknown) => {
        process.stderr.write(`archive lifecycle: ${errorText(e)}\n`)
        return { deleted: [], kept: [] }
      })
      .finally(() => {
        lifecycle = null
      })
  }
  setTimeout(run, LIFECYCLE_DELAY_MS).unref()
  setInterval(run, LIFECYCLE_MS).unref()
}
