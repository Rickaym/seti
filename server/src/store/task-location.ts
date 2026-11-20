import { sql, transaction, type Db } from '../db.js'

/** A worktree Seti made for a task, with the checkout it belongs to. */
export interface TaskWorktree {
  dir: string
  repo_path: string
}

/** A worktree record with the agent it belongs to. */
export interface WorktreeRecord extends TaskWorktree {
  task_id: string
  title: string
}

/** Where a task's working directory moves: a repo's directory, or a plain one without repo_id. */
export interface CwdMove {
  from: { repo_id: string | null; cwd: string }
  to: { repo_id: string | null; cwd: string }
  /** Keep the old working directory attached; false when another of the task's folders holds it. */
  keep: boolean
}

async function appendRepo(db: Db, taskId: string, repoId: string, dir: string): Promise<void> {
  await db`INSERT INTO task_repo (task_id, repo_id, position, dir)
    SELECT ${taskId}, ${repoId}, COALESCE(MAX(position), 0) + 1, ${dir} FROM task_repo WHERE task_id = ${taskId}`
}

/** The directories and repos of a task besides the one on its row, which is its working directory. */
export const taskLocation = {
  /** Every worktree Seti made for the task, those no longer attached to it included. */
  worktrees: async (taskId: string) => [
    ...(await sql<TaskWorktree[]>`SELECT w.dir, r.path AS repo_path FROM task_worktree w
      JOIN repo r ON r.id = w.repo_id WHERE w.task_id = ${taskId} ORDER BY w.dir`),
  ],
  /** The task's worktrees with their repo and the base branch Seti checks a lost one out on. */
  worktreeBases: async (taskId: string) =>
    sql<(TaskWorktree & { base_branch: string })[]>`SELECT w.dir, r.path AS repo_path, r.base_branch
      FROM task_worktree w JOIN repo r ON r.id = w.repo_id WHERE w.task_id = ${taskId} ORDER BY w.dir`,
  /** Every worktree directory Seti made, for any task. */
  allWorktreeDirs: async () => (await sql<{ dir: string }[]>`SELECT dir FROM task_worktree`).map((row) => row.dir),
  /** Worktree records of agents not archived; an archived agent keeps its records to restore. */
  liveWorktreeRecords: async () => [
    ...(await sql<WorktreeRecord[]>`SELECT w.task_id, t.title, w.dir, r.path AS repo_path FROM task_worktree w
      JOIN task t ON t.id = w.task_id JOIN repo r ON r.id = w.repo_id WHERE t.archived_at IS NULL ORDER BY w.dir`),
  ],
  /** Drops one worktree record, whose folder is gone. */
  forgetWorktree: async (taskId: string, dir: string) => {
    await sql`DELETE FROM task_worktree WHERE task_id = ${taskId} AND dir = ${dir}`
  },
  /** Makes another of the task's directories its working directory; the old one stays attached. */
  moveCwd: async (taskId: string, { from, to, keep }: CwdMove) => {
    await transaction(async (tx) => {
      if (to.repo_id === null) {
        await tx`DELETE FROM task_dir WHERE task_id = ${taskId} AND dir = ${to.cwd}`
      } else {
        await tx`DELETE FROM task_repo WHERE task_id = ${taskId} AND repo_id = ${to.repo_id}`
      }
      if (from.repo_id === null && keep) {
        await tx`INSERT INTO task_dir (task_id, dir) VALUES (${taskId}, ${from.cwd}) ON CONFLICT DO NOTHING`
      } else if (from.repo_id !== null) {
        await appendRepo(tx, taskId, from.repo_id, from.cwd)
      }
      await tx`UPDATE task SET cwd = ${to.cwd}, repo_id = ${to.repo_id} WHERE id = ${taskId}`
    })
  },
}
