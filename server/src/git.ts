import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { binaryPath } from './binaries.js'
import { WORKTREE_ROOT } from './config.js'

const exec = promisify(execFile)

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

/** Detached worktree at origin/<ref>, so the agent names its own branch. */
export async function createWorktree(repoPath: string, ref: string, name: string): Promise<string> {
  const dir = path.join(WORKTREE_ROOT, name)
  if (!fs.existsSync(dir)) {
    await git(repoPath, 'fetch', 'origin', ref)
    await git(repoPath, 'worktree', 'add', '--detach', dir, `origin/${ref}`)
  }
  return dir
}

/** Paths of every worktree of a checkout, the main one included; empty when git fails. */
export async function listWorktrees(repoPath: string): Promise<string[]> {
  try {
    const out = await git(repoPath, 'worktree', 'list', '--porcelain')
    return out.split('\n').flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : []))
  } catch {
    return []
  }
}

/** The main checkout a worktree belongs to; null outside git, in a bare repo's worktree, or in it. */
export async function mainCheckout(dir: string): Promise<string | null> {
  try {
    const common = await git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const main = path.basename(common) === '.git' ? path.dirname(common) : null
    return main === dir ? null : main
  } catch {
    return null
  }
}

/** Whether a checkout has uncommitted or untracked changes; false when git cannot tell. */
export async function hasLocalChanges(dir: string): Promise<boolean> {
  try {
    return (await git(dir, 'status', '--porcelain')) !== ''
  } catch {
    return false
  }
}

/** A worktree's commit and branch, and whether removing it would lose anything. */
export interface WorktreeState {
  head: string
  branch: string | null
  dirty: boolean
  /** HEAD is on a remote-tracking branch, so its commits survive the worktree. */
  pushed: boolean
}

export async function worktreeState(dir: string): Promise<WorktreeState> {
  const head = await git(dir, 'rev-parse', 'HEAD')
  const branch = await git(dir, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  const dirty = (await git(dir, 'status', '--porcelain')) !== ''
  const remotes = await git(dir, 'branch', '--remotes', '--contains', 'HEAD')
  return { head, branch: branch === '' ? null : branch, dirty, pushed: remotes !== '' }
}

/** Bytes a directory takes on disk, or null when du cannot tell. */
export async function directoryBytes(dir: string): Promise<number | null> {
  try {
    const { stdout } = await exec('du', ['-sb', dir], { maxBuffer: 1024 * 1024 })
    const bytes = Number(stdout.split('\t')[0])
    return Number.isFinite(bytes) ? bytes : null
  } catch {
    return null
  }
}

/** Checks a removed worktree out again at its branch, or detached at its commit when that fails. */
export async function recreateWorktree(repoPath: string, dir: string, branch: string | null, head: string) {
  await git(repoPath, 'worktree', 'prune')
  if (branch !== null) {
    try {
      await git(repoPath, 'worktree', 'add', dir, branch)
      return
    } catch {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  await git(repoPath, 'worktree', 'add', '--detach', dir, head)
}

export async function removeWorktree(repoPath: string, dir: string): Promise<void> {
  if (!dir.startsWith(WORKTREE_ROOT + path.sep)) {
    return
  }
  if (fs.existsSync(dir)) {
    await git(repoPath, 'worktree', 'remove', '--force', dir)
  } else {
    await git(repoPath, 'worktree', 'prune')
  }
}

/**
 * Writes a checkout's uncommitted changes, untracked files included, as a binary patch to `file`.
 * A scratch index stages them, so the checkout's own index stays as it was.
 */
export async function saveUncommitted(dir: string, file: string): Promise<void> {
  const index = `${file}.index`
  const env = { ...process.env, GIT_INDEX_FILE: index }
  try {
    await exec('git', ['-C', dir, 'read-tree', 'HEAD'], { env })
    await exec('git', ['-C', dir, 'add', '-A'], { env })
    const bin = binaryPath('git')
    if (bin === null) {
      throw new Error('git is not installed')
    }
    const child = spawn(bin, ['-C', dir, 'diff', '--cached', '--binary', 'HEAD'], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    await pipeline(child.stdout, fs.createWriteStream(file, { mode: 0o600 }))
    const code = await exited
    if (code !== 0) {
      throw new Error(`git diff exited with ${String(code)}`)
    }
  } finally {
    fs.rmSync(index, { force: true })
  }
}

/** Removes a linked worktree through its main checkout so git forgets it; false when it has none. */
export async function removeLinkedWorktree(dir: string): Promise<boolean> {
  const main = await mainCheckout(dir)
  if (main === null) {
    return false
  }
  await git(main, 'worktree', 'remove', '--force', dir)
  return true
}

/** The first word of `git config user.name` on this machine, or null when it has none. */
export async function gitFirstName(): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['config', '--global', 'user.name'])
    const [first = ''] = stdout.trim().split(/\s+/)
    return first === '' ? null : first
  } catch {
    return null
  }
}
