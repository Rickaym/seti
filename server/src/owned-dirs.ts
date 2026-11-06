import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { ARCHIVE_ROOT, MOD_FETCH_ROOT, SCRATCH_ROOT, WORKTREE_ROOT } from './config.js'
import { WORKSPACE_ROOT } from './workspace/dir.js'

/** The roots Seti makes per-agent folders in, each folder exactly one level below its root. */
export const OWNED_ROOTS = {
  scratch: SCRATCH_ROOT,
  worktrees: WORKTREE_ROOT,
  workspace: WORKSPACE_ROOT,
  archive: ARCHIVE_ROOT,
  modFetch: MOD_FETCH_ROOT,
} as const

export type OwnedRoot = keyof typeof OWNED_ROOTS

/** What a task points at on disk: its working directory, added directories and repos. */
type DirUser = Pick<Task, 'id' | 'cwd' | 'dirs' | 'repos'>

const SCRATCH_NAME = /^[a-z0-9-]+$/

export const usedDirs = (task: DirUser): string[] => [task.cwd, ...task.dirs, ...task.repos.map((repo) => repo.dir)]

export const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep)

function realOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

/**
 * The scratch folder Seti made for the task: its working directory or an added one, right in the
 * scratch root and named `<title slug>-<first 8 of its id>` the way createScratchDir names it.
 */
export function scratchDirOf(task: DirUser): string | null {
  const suffix = `-${task.id.slice(0, 8)}`
  return (
    [task.cwd, ...task.dirs].find((dir) => {
      const name = path.basename(dir)
      return (
        path.dirname(dir) === SCRATCH_ROOT &&
        SCRATCH_NAME.test(name) &&
        name.endsWith(suffix) &&
        name.length > suffix.length
      )
    }) ?? null
  )
}

/** A root so broad that one level below it holds folders Seti never made. */
function tooBroad(root: string): boolean {
  const resolved = path.resolve(root)
  return resolved === path.parse(resolved).root || resolved === os.homedir()
}

/**
 * Why Seti must not remove `dir` from `root`, or null when it may. It may only when `dir` is a
 * plain absolute path exactly one level below the root, a real directory rather than a symlink,
 * whose real path stays in the root, and that no task in `others` uses or works inside.
 */
export function removalRefusal(dir: string, root: OwnedRoot, others: readonly DirUser[]): string | null {
  const rootPath = OWNED_ROOTS[root]
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir || dir.endsWith(path.sep)) {
    return `${dir} is not a plain absolute path`
  }
  if (tooBroad(rootPath)) {
    return `${rootPath} is too broad a root to remove folders from`
  }
  if (dir === rootPath || path.dirname(dir) !== rootPath) {
    return `${dir} is not directly inside ${rootPath}`
  }
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (stat === undefined) {
    return `${dir} does not exist`
  }
  if (stat.isSymbolicLink()) {
    return `${dir} is a symlink`
  }
  if (!stat.isDirectory()) {
    return `${dir} is not a directory`
  }
  const realRoot = realOrNull(rootPath)
  const real = realOrNull(dir)
  if (realRoot === null || real === null || real !== path.join(realRoot, path.basename(dir))) {
    return `${dir} resolves outside ${rootPath}`
  }
  for (const other of others) {
    const used = usedDirs(other).find((p) => within(p, dir) || within(realOrNull(p) ?? p, real))
    if (used !== undefined) {
      return `agent ${other.id} uses ${used}`
    }
  }
  return null
}

const PROC = '/proc'

/** The real paths processes work in, read from /proc; empty where there is no /proc. */
async function processCwds(): Promise<{ pid: string; cwd: string }[]> {
  const pids = (await fs.promises.readdir(PROC).catch(() => [])).filter((name) => /^\d+$/.test(name))
  const found = await Promise.all(
    pids.map(async (pid) => {
      const cwd = await fs.promises.readlink(path.join(PROC, pid, 'cwd')).catch(() => null)
      return cwd === null ? [] : [{ pid, cwd: cwd.replace(/ \(deleted\)$/, '') }]
    }),
  )
  return found.flat()
}

/** The git directory of a checkout or worktree at `dir`, or null when it is neither. */
function gitDirOf(dir: string): string | null {
  const dotGit = path.join(dir, '.git')
  const stat = fs.lstatSync(dotGit, { throwIfNoEntry: false })
  if (stat?.isDirectory() === true) {
    return dotGit
  }
  if (stat?.isFile() !== true) {
    return null
  }
  const line = /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim()
  return line === undefined ? null : path.resolve(dir, line)
}

/** Why a folder is in use now: a process works in it or git holds a lock in it; else null. */
export async function busyReason(dir: string): Promise<string | null> {
  const real = realOrNull(dir) ?? dir
  const user = (await processCwds()).find(({ cwd }) => within(cwd, real))
  if (user !== undefined) {
    return `process ${user.pid} works in ${user.cwd}`
  }
  const gitDir = gitDirOf(dir)
  if (gitDir !== null && fs.existsSync(path.join(gitDir, 'index.lock'))) {
    return `git holds a lock in ${dir}`
  }
  return null
}

/** Removes a folder after checking it again; returns why it refused instead when it must not. */
export async function removeOwnedDir(dir: string, root: OwnedRoot, others: readonly DirUser[]): Promise<string | null> {
  const refusal = removalRefusal(dir, root, others) ?? (await busyReason(dir))
  if (refusal !== null) {
    return refusal
  }
  await fs.promises.rm(dir, { recursive: true, maxRetries: 2 })
  return null
}
