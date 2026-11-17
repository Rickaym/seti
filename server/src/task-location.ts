import fs from 'node:fs'
import path from 'node:path'
import { extraDirs, type Task } from '@seti/shared'
import { refuseArchived } from './archive-guard.js'
import { audit } from './audit.js'
import { capabilityCache } from './capabilities.js'
import { SCRATCH_ROOT } from './config.js'
import { tasks } from './db.js'
import { HttpError } from './http.js'
import { taskLocation } from './store/task-location.js'

const SLUG_CHARS = 40

/** A lowercase, dash-separated name for a title, or `agent` when nothing is left of it. */
export function titleSlug(title: string): string {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const slug = words.join('-').slice(0, SLUG_CHARS)
  return slug === '' ? 'agent' : slug.replace(/-$/, '')
}

/** Creates the fresh working directory of an agent started without a repo or directory. */
export function createScratchDir(taskId: string, title: string): string {
  const dir = path.join(SCRATCH_ROOT, `${titleSlug(title)}-${taskId.slice(0, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const inside = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep)

/** The folder Seti made for the agent under the scratch root, wherever inside it the agent works. */
function ownFolder(task: Pick<Task, 'cwd' | 'dirs'>): string | null {
  const made = [task.cwd, ...task.dirs].find((dir) => inside(dir, SCRATCH_ROOT) && dir !== SCRATCH_ROOT)
  if (made === undefined) {
    return null
  }
  return path.join(SCRATCH_ROOT, path.relative(SCRATCH_ROOT, made).split(path.sep)[0] ?? '')
}

const realDir = (dir: string) =>
  fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true ? fs.realpathSync(dir) : null

/** The existing directory a path names, refused unless it lies inside one of the agent's folders. */
function ownDirectory(task: Task, raw: string): string {
  const roots = [task.cwd, ...extraDirs(task)]
  const wanted = path.resolve(task.cwd, raw)
  const real = realDir(wanted)
  if (real === null) {
    throw new HttpError(400, `${wanted} is not an existing directory`)
  }
  const held = roots.some((root) => {
    const realRoot = realDir(root)
    return realRoot !== null && inside(real, realRoot)
  })
  if (!held) {
    throw new HttpError(403, `Your working directory stays inside your own folders: ${roots.join(', ')}`)
  }
  return wanted
}

/**
 * Moves an agent's session into a directory inside its own folders, such as a repo it cloned, so
 * Claude Code loads that repo's project config; the folders it had stay attached.
 */
export async function setTaskCwd(task: Task, raw: string): Promise<string> {
  refuseArchived(task)
  const cwd = ownDirectory(task, raw)
  if (cwd === task.cwd) {
    return cwd
  }
  const repo = task.repos.find((entry) => entry.dir === cwd)
  const others = extraDirs(task).filter((dir) => dir !== cwd)
  await taskLocation.moveCwd(task.id, {
    from: { repo_id: task.repo_id, cwd: task.cwd },
    to: { repo_id: repo?.id ?? null, cwd },
    keep: ![cwd, ...others].some((root) => inside(task.cwd, root)),
  })
  capabilityCache.prewarm(cwd)
  await audit.record({
    actor: 'user',
    kind: 'task.cwd_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Moved task "${task.title}" to ${repo?.slug ?? cwd}`,
    detail: { title: task.title, cwd, previous_cwd: task.cwd, repo: repo?.slug ?? null },
  })
  return cwd
}

const here = (task: Task, dir: string) => (dir === task.cwd ? ' (your working directory)' : '')

/** The places of an agent from before agents cloned for themselves, which spans several. */
function spanLines(task: Task): string[] {
  const inRepos = task.repos.some((repo) => repo.dir === task.cwd)
  const worktrees = task.repos.filter((repo) => repo.worktree).map((repo) => repo.slug)
  return [
    'This task spans several directories. You can read and edit all of them:',
    ...(inRepos ? [] : [`- ${task.cwd} (your working directory)`]),
    ...task.repos.map((repo) => `- ${repo.slug}: ${repo.dir}${here(task, repo.dir)}`),
    ...task.dirs.map((dir) => `- ${dir}`),
    ...(worktrees.length === 0
      ? []
      : [`Seti made a detached worktree of ${worktrees.join(', ')}; create a branch in each one you change.`]),
  ]
}

/** Tells an agent where its own folder is and how to bring repos into it. */
export async function taskFolderContext(taskId: string): Promise<string | null> {
  const task = await tasks.get(taskId)
  if (!task) {
    return null
  }
  const folder = task.repos.length === 0 ? ownFolder(task) : null
  if (folder === null) {
    return extraDirs(task).length === 0 ? null : spanLines(task).join('\n')
  }
  return [
    `Your own working folder is ${folder}. Clone the repos you need into it with git clone or gh repo clone, and make worktrees inside it.`,
    "Claude Code loads a repo's own .mcp.json, settings, hooks and commands only from the directory your session runs in: once you cloned the repo you will work in, call seti set_working_directory with its folder, and your conversation carries on there from your next turn.",
    ...(task.cwd === folder ? [] : [`Your session runs in ${task.cwd}.`]),
  ].join('\n')
}
