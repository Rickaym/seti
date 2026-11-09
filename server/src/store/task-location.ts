import { sql, transaction, type Db } from '../db.js'

/** A worktree Seti made for a task, with the checkout it belongs to. */
export interface TaskWorktree {
  dir: string
  repo_path: string
}

/** Where a task's working directory moves: a repo's directory, or a plain one without repo_id. */
export interface CwdMove {
  from: { repo_id: string | null; cwd: string }
  to: { repo_id: string | null; cwd: string }
}

async function appendRepo(db: Db, taskId: string, repoId: string, dir: string): Promise<void> {
  await db`INSERT INTO task_repo (task_id, repo_id, position, dir)
    SELECT ${taskId}, ${repoId}, COALESCE(MAX(position), 0) + 1, ${dir} FROM task_repo WHERE task_id = ${taskId}`
}

/** The directories and repos of a task besides the one on its row, which is its working directory. */
export const taskLocation = {
  addRepo: async (taskId: string, repoId: string, dir: string, worktree: boolean) => {
    await transaction(async (tx) => {
      await appendRepo(tx, taskId, repoId, dir)
      if (worktree) {
        await tx`INSERT INTO task_worktree (task_id, repo_id, dir) VALUES (${taskId}, ${repoId}, ${dir})
          ON CONFLICT DO NOTHING`
      }
    })
  },
  /** True when the repo was one of the task's extra repos. */
  removeRepo: async (taskId: string, repoId: string) =>
    (await sql`DELETE FROM task_repo WHERE task_id = ${taskId} AND repo_id = ${repoId}`).count > 0,
  /** True when the directory was not added before. */
  addDir: async (taskId: string, dir: string) =>
    (await sql`INSERT INTO task_dir (task_id, dir) VALUES (${taskId}, ${dir}) ON CONFLICT DO NOTHING`).count > 0,
  /** True when the directory was added to the task. */
  removeDir: async (taskId: string, dir: string) =>
    (await sql`DELETE FROM task_dir WHERE task_id = ${taskId} AND dir = ${dir}`).count > 0,
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
  /** The worktree Seti made earlier for this task and repo, if any. */
  worktreeOf: async (taskId: string, repoId: string) =>
    (
      await sql<{ dir: string }[]>`SELECT dir FROM task_worktree
        WHERE task_id = ${taskId} AND repo_id = ${repoId} ORDER BY dir LIMIT 1`
    ).at(0)?.dir,
  /** Makes another of the task's directories its working directory; the old one stays attached. */
  moveCwd: async (taskId: string, { from, to }: CwdMove) => {
    await transaction(async (tx) => {
      if (to.repo_id === null) {
        await tx`DELETE FROM task_dir WHERE task_id = ${taskId} AND dir = ${to.cwd}`
      } else {
        await tx`DELETE FROM task_repo WHERE task_id = ${taskId} AND repo_id = ${to.repo_id}`
      }
      if (from.repo_id === null) {
        await tx`INSERT INTO task_dir (task_id, dir) VALUES (${taskId}, ${from.cwd}) ON CONFLICT DO NOTHING`
      } else {
        await appendRepo(tx, taskId, from.repo_id, from.cwd)
      }
      await tx`UPDATE task SET cwd = ${to.cwd}, repo_id = ${to.repo_id} WHERE id = ${taskId}`
    })
  },
}
