import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REBUILDABLE_DIRS, REBUILDABLE_IF_IGNORED, type Task } from '@seti/shared'
import {
  ARCHIVE_ROOT,
  CODEX_ROOT,
  MOD_FETCH_ROOT,
  SANDBOX_ROOT,
  SCRATCH_ROOT,
  SHARED_TOOLS_ROOT,
  TRASH_ROOT,
  WORKTREE_ROOT,
} from './config.js'
import { removeLinkedWorktree } from './git.js'
import { WORKSPACE_ROOT } from './workspace/dir.js'

/** The roots Seti makes folders of its own in, each folder exactly one level below its root. */
export const OWNED_ROOTS = {
  scratch: SCRATCH_ROOT,
  worktrees: WORKTREE_ROOT,
  workspace: WORKSPACE_ROOT,
  sandbox: SANDBOX_ROOT,
  archive: ARCHIVE_ROOT,
  modFetch: MOD_FETCH_ROOT,
  sharedTools: SHARED_TOOLS_ROOT,
  trash: TRASH_ROOT,
  codex: CODEX_ROOT,
} as const

export type OwnedRoot = keyof typeof OWNED_ROOTS

/** What a task points at on disk: its working directory, added directories and repos. */
type DirUser = Pick<Task, 'id' | 'cwd' | 'dirs' | 'repos'>

const SCRATCH_NAME = /^[a-z0-9-]+$/

/** The folder that holds a sandboxed agent's private home, /tmp and run files. */
export const sandboxDirOf = (taskId: string) => path.join(SANDBOX_ROOT, taskId)

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

/** The device and inode of each file right in `dir`, as `dev:ino`. */
async function filesIn(dir: string): Promise<Set<string>> {
  const names = await fs.promises.readdir(dir).catch(() => [])
  const stats = await Promise.all(names.map(async (name) => fs.promises.lstat(path.join(dir, name)).catch(() => null)))
  return new Set(stats.flatMap((stat) => (stat?.isFile() === true ? [`${String(stat.dev)}:${String(stat.ino)}`] : [])))
}

/** A process whose program is one of the files right in `dir`, matched by inode across mounts. */
async function programUser(dir: string): Promise<string | null> {
  const files = await filesIn(dir)
  if (files.size === 0) {
    return null
  }
  const pids = (await fs.promises.readdir(PROC).catch(() => [])).filter((name) => /^\d+$/.test(name))
  for (const pid of pids) {
    const stat = await fs.promises.stat(path.join(PROC, pid, 'exe')).catch(() => null)
    if (stat !== null && files.has(`${String(stat.dev)}:${String(stat.ino)}`)) {
      return pid
    }
  }
  return null
}

/**
 * Why a folder is in use now: a process works in it or runs a program from it, or git holds a
 * lock in it; else null.
 */
export async function busyReason(dir: string): Promise<string | null> {
  const real = realOrNull(dir) ?? dir
  const user = (await processCwds()).find(({ cwd }) => within(cwd, real))
  if (user !== undefined) {
    return `process ${user.pid} works in ${user.cwd}`
  }
  const runner = await programUser(dir)
  if (runner !== null) {
    return `process ${runner} runs a program in ${dir}`
  }
  const gitDir = gitDirOf(dir)
  if (gitDir !== null && fs.existsSync(path.join(gitDir, 'index.lock'))) {
    return `git holds a lock in ${dir}`
  }
  return null
}

/**
 * Removes a folder after checking it again, a read-only one made writable first, as Codex's are;
 * returns why it refused instead when it must not.
 */
export async function removeOwnedDir(dir: string, root: OwnedRoot, others: readonly DirUser[]): Promise<string | null> {
  const refusal = removalRefusal(dir, root, others) ?? (await busyReason(dir))
  if (refusal !== null) {
    return refusal
  }
  if (gitDirOf(dir) !== null && fs.lstatSync(path.join(dir, '.git')).isFile()) {
    try {
      if (await removeLinkedWorktree(dir)) {
        return null
      }
    } catch {
      // git could not remove it; the folder goes below and git prunes its record later
    }
  }
  const { mode } = await fs.promises.stat(dir)
  if ((mode & 0o200) === 0) {
    await fs.promises.chmod(dir, mode | 0o700)
  }
  await fs.promises.rm(dir, { recursive: true, maxRetries: 2 })
  return null
}

const REBUILDABLE_NAMES = new Set<string>([...REBUILDABLE_DIRS, ...REBUILDABLE_IF_IGNORED])

/** Where a rebuildable folder lies: an agent's own folder, one level below an owned root. */
export interface NestedIn {
  base: string
  root: OwnedRoot
}

/** The one folder with no rebuildable name that Clean empties: a sandbox's own /tmp. */
const isSandboxTmp = (dir: string, { base, root }: NestedIn) => root === 'sandbox' && dir === path.join(base, 'tmp')

/**
 * Why Seti must not remove `dir`, a rebuildable folder in the agent folder `base`, or null
 * when it may: `base` passes the same checks as a folder Seti removes whole, and `dir` is a
 * plain path inside it with a rebuildable name, a real directory reached through no symlink.
 */
export function nestedRefusal(dir: string, inside: NestedIn, others: readonly DirUser[]): string | null {
  const baseRefusal = removalRefusal(inside.base, inside.root, others)
  if (baseRefusal !== null) {
    return baseRefusal
  }
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir || dir === inside.base || !within(dir, inside.base)) {
    return `${dir} is not a plain path inside ${inside.base}`
  }
  if (!REBUILDABLE_NAMES.has(path.basename(dir)) && !isSandboxTmp(dir, inside)) {
    return `${dir} is not a rebuildable folder`
  }
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (stat?.isDirectory() !== true) {
    return `${dir} is not a directory`
  }
  const realBase = realOrNull(inside.base)
  if (realBase === null || realOrNull(dir) !== path.join(realBase, path.relative(inside.base, dir))) {
    return `${dir} is reached through a symlink`
  }
  return null
}

/** Removes a rebuildable folder in an agent's folder after checking both again; else why not. */
export async function removeNestedDir(
  dir: string,
  inside: NestedIn,
  others: readonly DirUser[],
): Promise<string | null> {
  const refusal = nestedRefusal(dir, inside, others) ?? (await busyReason(inside.base)) ?? (await busyReason(dir))
  if (refusal !== null) {
    return refusal
  }
  await fs.promises.rm(dir, { recursive: true, maxRetries: 2 })
  return null
}
