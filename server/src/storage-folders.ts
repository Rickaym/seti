import fs from 'node:fs'
import path from 'node:path'
import type { StorageFolderKind, Task } from '@seti/shared'
import { WORKTREE_ROOT } from './config.js'
import { sandboxDirOf, scratchDirOf, usedDirs, within, type NestedIn } from './owned-dirs.js'
import { taskLocation } from './store/task-location.js'
import { workspaceDir } from './workspace/dir.js'

/** One folder of an agent on disk; `owned` names where Clean may work for the folders Seti made. */
export interface AgentFolder {
  kind: StorageFolderKind
  path: string
  owned: NestedIn | null
}

const isDir = (dir: string) => fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === true

/** The folders Seti made for the agent: its scratch folder, worktrees, workspace and sandbox. */
async function ownedFolders(task: Task, worktreeDirs?: readonly string[]): Promise<AgentFolder[]> {
  const scratch = scratchDirOf(task)
  const worktrees = (worktreeDirs ?? (await taskLocation.worktrees(task.id)).map((worktree) => worktree.dir)).filter(
    (dir) => path.dirname(dir) === WORKTREE_ROOT,
  )
  const sandbox = sandboxDirOf(task.id)
  const workspace = workspaceDir(task.id)
  return [
    ...(scratch === null
      ? []
      : [{ kind: 'scratch', path: scratch, owned: { base: scratch, root: 'scratch' } } as const]),
    ...worktrees.map((dir) => ({ kind: 'worktree', path: dir, owned: { base: dir, root: 'worktrees' } }) as const),
    { kind: 'workspace', path: workspace, owned: { base: workspace, root: 'workspace' } },
    { kind: 'sandbox', path: sandbox, owned: { base: sandbox, root: 'sandbox' } },
  ]
}

/**
 * Every folder of the agent that exists: those Seti made for it, and the checkouts and folders it
 * was given, which Clean never touches. A folder inside another of them is counted there.
 * `worktreeDirs` saves a query when the caller read every agent's worktrees at once.
 */
export async function agentFolders(task: Task, worktreeDirs?: readonly string[]): Promise<AgentFolder[]> {
  const owned = (await ownedFolders(task, worktreeDirs)).filter((folder) => isDir(folder.path))
  const given = [...new Set(usedDirs(task))]
    .filter((dir) => isDir(dir) && !owned.some((folder) => within(dir, folder.path)))
    .map((dir): AgentFolder => ({ kind: 'checkout', path: dir, owned: null }))
  const all = [...owned, ...given]
  return all.filter(
    (folder) => !all.some((other) => other !== folder && other.path !== folder.path && within(folder.path, other.path)),
  )
}
