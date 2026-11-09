import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { audit } from './audit.js'
import { WORKTREE_ROOT } from './config.js'
import { createWorktree, git } from './git.js'
import { workingDirs } from './session-options.js'
import { taskLocation } from './store/task-location.js'

/** The worktrees Seti made that the agent still works in and that are gone from disk. */
async function missingWorktrees(task: Task) {
  const used = new Set([task.cwd, ...workingDirs(task)])
  return (await taskLocation.worktreeBases(task.id)).filter(
    (worktree) =>
      used.has(worktree.dir) && worktree.dir.startsWith(WORKTREE_ROOT + path.sep) && !fs.existsSync(worktree.dir),
  )
}

/**
 * Checks out again, on its repo's base branch, each worktree of the agent that something outside
 * Seti removed, so its process can start, and tells the transcript through `note`.
 */
export async function restoreMissingWorktrees(task: Task, note: (text: string) => Promise<unknown>): Promise<void> {
  for (const worktree of await missingWorktrees(task)) {
    try {
      await git(worktree.repo_path, 'worktree', 'prune')
      await createWorktree(worktree.repo_path, worktree.base_branch, path.basename(worktree.dir))
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      throw new Error(`The worktree ${worktree.dir} is missing and Seti could not check it out again: ${why}`)
    }
    await audit.record({
      actor: 'system',
      kind: 'task.worktree_restored',
      subject_type: 'task',
      subject_id: task.id,
      summary: `Checked out the missing worktree ${worktree.dir} of task "${task.title}" again`,
      detail: { title: task.title, dir: worktree.dir, repo: worktree.repo_path, ref: `origin/${worktree.base_branch}` },
    })
    await note(
      `${worktree.dir} was missing, so Seti checked it out again at origin/${worktree.base_branch}. ` +
        'Commits on a branch are still there; uncommitted changes from before are not.',
    )
  }
}
