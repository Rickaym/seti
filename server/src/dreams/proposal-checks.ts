import fs from 'node:fs'
import path from 'node:path'
import type { DreamProposalInput, Task } from '@seti/shared'
import { walkSize } from '../dir-size.js'
import { folderUnsavedWork } from '../git-state.js'
import { agentGitWithin } from '../git.js'
import { usedDirs, within } from '../owned-dirs.js'
import { rebuildableKind } from '../rebuildable.js'
import { SETI_FILES, workspaceDir } from '../workspace/dir.js'

/** `trash_item_max`: the largest thing one clean-up may move into the trash. */
const TRASH_ITEM_MAX = 5 * 1024 ** 3
const GIT_MS = 15_000
/** Workspace entries Seti writes or holds for the user, which no clean-up may touch. */
const SETI_HELD = new Set([...SETI_FILES, 'uploads', 'inbox', 'secrets', 'dreams'])

type Agent = Pick<Task, 'id' | 'cwd' | 'dirs' | 'repos'>

/** What a clean-up would move or delete, once every check passed. */
export interface Checked {
  /** The folder or file to move, or the checkout that holds the branch. */
  path: string
  bytes: number
  branch?: string
}

const gitIn = async (dir: string, ...args: string[]) => agentGitWithin(GIT_MS, dir, ...args)
const gitOrNull = async (dir: string, ...args: string[]) => gitIn(dir, ...args).catch(() => null)

/** The branch target's checkout and name: `<checkout path>:<branch>`. */
function splitBranch(target: string): { dir: string; branch: string } | null {
  const at = target.lastIndexOf(':')
  const branch = target.slice(at + 1)
  return at <= 0 || !/^[\w./-]+$/.test(branch) || branch.startsWith('-') ? null : { dir: target.slice(0, at), branch }
}

/** Why a path is not a plain, real path inside the agent's own folders; null when it is. */
function placeRefusal(target: string, agent: Agent, others: readonly Agent[]): string | null {
  if (!path.isAbsolute(target) || path.normalize(target) !== target || target.endsWith(path.sep)) {
    return `${target} is not a plain absolute path`
  }
  const real = fs.existsSync(target) ? fs.realpathSync(target) : null
  if (real === null) {
    return `${target} does not exist`
  }
  if (real !== target) {
    return `${target} goes through a symlink`
  }
  const workspace = workspaceDir(agent.id)
  if (within(target, workspace)) {
    const first = path.relative(workspace, target).split(path.sep)[0] ?? ''
    return target === workspace || SETI_HELD.has(first) ? `${target} is Seti's, not the agent's` : null
  }
  const roots = usedDirs(agent)
  if (roots.includes(target) || !roots.some((root) => within(target, root))) {
    return `${target} is not inside the agent's own folders`
  }
  const other = others.find((o) => o.id !== agent.id && usedDirs(o).some((d) => within(d, target) || within(target, d)))
  return other === undefined ? null : `another agent (${other.id}) uses ${target}`
}

/** Why trashing a path would lose work git knows of; null for plain or rebuildable files. */
async function trashGitRefusal(target: string): Promise<string | null> {
  const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target)
  const top = await gitOrNull(dir, 'rev-parse', '--show-toplevel')
  if (top === null || top === target) {
    return top === target ? `${target} is a whole checkout; propose its worktree instead` : folderUnsavedWork(target)
  }
  const status = await gitIn(top, 'status', '--porcelain', '--ignored', '--untracked-files=all', '--', target)
  const tracked = await gitIn(top, 'ls-files', '--', target)
  if (tracked !== '') {
    return `${target} holds files git tracks`
  }
  if (status.split('\n').some((line) => line.startsWith('??'))) {
    return `${target} holds untracked files git does not ignore`
  }
  return rebuildableKind(target) === null ? `${target} is ignored by git but is not rebuildable output` : null
}

/** Why removing a worktree would lose work; null for a clean, pushed linked worktree. */
async function worktreeRefusal(target: string): Promise<string | null> {
  if (fs.lstatSync(path.join(target, '.git'), { throwIfNoEntry: false })?.isFile() !== true) {
    return `${target} is not a linked worktree`
  }
  const untracked = await gitIn(target, 'status', '--porcelain', '--untracked-files=all')
  if (untracked !== '') {
    return `${target} has uncommitted or untracked files`
  }
  const unpushed = await gitIn(target, 'rev-list', '--count', 'HEAD', '--not', '--remotes')
  if (unpushed !== '0') {
    return `${target} has ${unpushed} commit(s) that are not pushed`
  }
  return (await gitIn(target, 'stash', 'list')) === '' ? null : `${target}'s repository has stashes`
}

/** Why deleting a branch would lose commits or break a checkout; null for a merged, idle branch. */
async function branchRefusal(dir: string, branch: string): Promise<string | null> {
  const tip = await gitOrNull(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
  if (tip === null) {
    return `${branch} is not a branch of ${dir}`
  }
  const checkedOut = (await gitIn(dir, 'worktree', 'list', '--porcelain'))
    .split('\n')
    .some((line) => line === `branch refs/heads/${branch}`)
  if (checkedOut) {
    return `${branch} is checked out in a worktree`
  }
  const base = (await gitOrNull(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')) ?? 'origin/main'
  const merged = await gitOrNull(dir, 'merge-base', '--is-ancestor', tip, base)
  return merged === null ? `${branch} has commits not merged into ${base}` : null
}

async function sizeOf(target: string): Promise<number> {
  const stat = fs.statSync(target)
  return stat.isDirectory() ? (await walkSize(target)).size.bytes : stat.size
}

/**
 * Checks a proposed clean-up, when the dream files it and again when the user allows it: the
 * target is a real path in the agent's own folders that no other agent uses, and removing it
 * loses nothing git or the user would want. Answers what to remove, or why not.
 */
export async function checkProposal(
  input: DreamProposalInput,
  agent: Agent,
  others: readonly Agent[],
): Promise<Checked | string> {
  const parts = input.kind === 'delete_branch' ? splitBranch(input.target) : { dir: input.target, branch: '' }
  if (parts === null) {
    return 'A branch target is the checkout path, a colon and the branch name'
  }
  const place = placeRefusal(parts.dir, agent, others)
  if (place !== null) {
    return place
  }
  if (input.kind === 'delete_branch') {
    return (await branchRefusal(parts.dir, parts.branch)) ?? { path: parts.dir, bytes: 0, branch: parts.branch }
  }
  const git = input.kind === 'trash' ? await trashGitRefusal(parts.dir) : await worktreeRefusal(parts.dir)
  if (git !== null) {
    return git
  }
  const bytes = await sizeOf(parts.dir)
  return bytes > TRASH_ITEM_MAX ? `${parts.dir} is over 5 GB, too large for the trash` : { path: parts.dir, bytes }
}
