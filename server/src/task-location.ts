import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AuditActor, Repo, Task, TaskRepoInput } from '@seti/shared'
import { refuseArchived } from './archive-guard.js'
import { audit } from './audit.js'
import { capabilityCache } from './capabilities.js'
import { CLAUDE_HOME, SCRATCH_ROOT, SETI_HOME, WORKTREE_ROOT } from './config.js'
import { repos } from './db.js'
import { refuseOtherAgent } from './ea-guard.js'
import { createWorktree } from './git.js'
import { HttpError } from './http.js'
import { mountProblem } from './sandbox-mounts.js'
import { sandboxHiddenPaths } from './sandbox.js'
import { sandboxContext } from './session-options.js'
import { sandboxPolicy } from './store/sandbox.js'
import { taskLocation } from './store/task-location.js'
import { recordSeeds, seedWorktrees } from './warm-caches.js'

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

/** The worktree directory name for a task's repo: `<repo>-<task>`, numbered when taken. */
export function worktreeName(repo: Pick<Repo, 'slug'>, taskId: string, taken: (name: string) => boolean): string {
  const base = `${repo.slug.split('/').at(-1) ?? 'repo'}-${taskId.slice(0, 8)}`
  let name = base
  let n = 1
  while (taken(name)) {
    n += 1
    name = `${base}-${String(n)}`
  }
  return name
}

function expandHome(raw: string): string {
  if (raw === '~') {
    return os.homedir()
  }
  return raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw
}

const hiddenSegment = (dir: string) =>
  !dir.startsWith(WORKTREE_ROOT + path.sep) && dir.split(path.sep).some((part) => part.startsWith('.'))

/** The directory a user named, resolved; refused where the sandbox could not mount it. */
async function checkTaskDir(raw: string): Promise<string> {
  const expanded = expandHome(raw)
  if (!path.isAbsolute(expanded)) {
    throw new HttpError(400, 'Give an absolute path or one under ~/')
  }
  const dir = path.resolve(expanded)
  if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new HttpError(400, `${dir} is not an existing directory`)
  }
  if (hiddenSegment(dir)) {
    throw new HttpError(400, `${dir} is a hidden path`)
  }
  const ctx = sandboxContext()
  const problem = mountProblem(dir, {
    home: ctx.home,
    setiHome: SETI_HOME,
    worktreeRoot: WORKTREE_ROOT,
    claudeHome: CLAUDE_HOME,
    hidden: sandboxHiddenPaths(await sandboxPolicy.get(), ctx),
  })
  if (problem !== null) {
    throw new HttpError(400, problem)
  }
  return dir
}

const usedBy = (task: Task, dir: string) =>
  dir === task.cwd || task.dirs.includes(dir) || task.repos.some((r) => r.dir === dir)

/** The repo's directory for the task, and whether Seti just made it as a worktree. */
async function placeRepo(task: Task, repo: Repo, input: TaskRepoInput): Promise<{ dir: string; made: boolean }> {
  if (input.worktree !== true) {
    return { dir: repo.path, made: false }
  }
  const earlier = await taskLocation.worktreeOf(task.id, repo.id)
  if (earlier !== undefined && fs.existsSync(earlier)) {
    return { dir: earlier, made: false }
  }
  const name = worktreeName(repo, task.id, (candidate) => fs.existsSync(path.join(WORKTREE_ROOT, candidate)))
  return { dir: await createWorktree(repo.path, input.ref ?? repo.base_branch, name), made: true }
}

/** Adds a registered repo to a task, as its checkout or a worktree of its own. */
export async function addTaskRepo(task: Task, input: TaskRepoInput, actor: AuditActor = 'user'): Promise<void> {
  refuseOtherAgent(task.id)
  refuseArchived(task)
  const repo = await repos.get(input.repo_id)
  if (!repo) {
    throw new HttpError(400, 'Unknown repo')
  }
  if (task.repos.some((entry) => entry.id === repo.id)) {
    throw new HttpError(409, `${repo.slug} is already part of this agent`)
  }
  const { dir, made } = await placeRepo(task, repo, input)
  if (usedBy(task, dir)) {
    throw new HttpError(409, `${dir} is already part of this agent`)
  }
  const worktree = dir !== repo.path
  await taskLocation.addRepo(task.id, repo.id, dir, worktree)
  await audit.record({
    actor,
    kind: 'task.repo_added',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Added ${repo.slug} to task "${task.title}"${worktree ? ' in a worktree' : ''}`,
    detail: { title: task.title, repo: repo.slug, dir, worktree },
  })
  if (made) {
    const targets = [{ repo, dir }]
    await recordSeeds(task, targets, await seedWorktrees(targets), actor)
  }
}

/** Takes a repo off a task; its files stay, a worktree Seti made until the task is deleted. */
export async function removeTaskRepo(task: Task, repoId: string, actor: AuditActor = 'user'): Promise<void> {
  refuseOtherAgent(task.id)
  refuseArchived(task)
  const entry = task.repos.find((repo) => repo.id === repoId)
  if (!entry) {
    throw new HttpError(404, 'That repo is not part of this agent')
  }
  if (entry.dir === task.cwd) {
    throw new HttpError(409, `${entry.slug} is the working directory; make another one the working directory first`)
  }
  await taskLocation.removeRepo(task.id, repoId)
  await audit.record({
    actor,
    kind: 'task.repo_removed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Removed ${entry.slug} from task "${task.title}"`,
    detail: { title: task.title, repo: entry.slug, dir: entry.dir, worktree: entry.worktree },
  })
}

/** Lets a task's agent read and edit another existing directory from its next turn. */
export async function addTaskDir(task: Task, raw: string, actor: AuditActor = 'user'): Promise<void> {
  refuseOtherAgent(task.id)
  refuseArchived(task)
  const dir = await checkTaskDir(raw)
  if (usedBy(task, dir)) {
    throw new HttpError(409, `${dir} is already part of this agent`)
  }
  await taskLocation.addDir(task.id, dir)
  await audit.record({
    actor,
    kind: 'task.dir_added',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Added ${dir} to task "${task.title}"`,
    detail: { title: task.title, dir },
  })
}

/** Takes a directory off a task; nothing on disk changes. */
export async function removeTaskDir(task: Task, raw: string, actor: AuditActor = 'user'): Promise<void> {
  refuseOtherAgent(task.id)
  refuseArchived(task)
  const dir = path.resolve(expandHome(raw))
  if (dir === task.cwd) {
    throw new HttpError(409, `${dir} is the working directory; make another one the working directory first`)
  }
  if (!task.dirs.includes(dir)) {
    throw new HttpError(404, 'That directory is not part of this agent')
  }
  await taskLocation.removeDir(task.id, dir)
  await audit.record({
    actor,
    kind: 'task.dir_removed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Removed ${dir} from task "${task.title}"`,
    detail: { title: task.title, dir },
  })
}

/** Makes a repo or directory of the task its working directory; the old one stays attached. */
export async function setTaskCwd(task: Task, raw: string, actor: AuditActor = 'user'): Promise<void> {
  refuseArchived(task)
  const cwd = path.resolve(expandHome(raw))
  if (cwd === task.cwd) {
    return
  }
  const repo = task.repos.find((entry) => entry.dir === cwd)
  if (repo === undefined && !task.dirs.includes(cwd)) {
    throw new HttpError(400, 'Add the repo or directory to this agent first')
  }
  if (!fs.existsSync(cwd)) {
    throw new HttpError(409, `${cwd} no longer exists`)
  }
  await taskLocation.moveCwd(task.id, {
    from: { repo_id: task.repo_id, cwd: task.cwd },
    to: { repo_id: repo?.id ?? null, cwd },
  })
  capabilityCache.prewarm(cwd)
  await audit.record({
    actor,
    kind: 'task.cwd_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Moved task "${task.title}" to ${repo?.slug ?? cwd}`,
    detail: { title: task.title, cwd, previous_cwd: task.cwd, repo: repo?.slug ?? null },
  })
}
