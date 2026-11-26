import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { WORKTREE_ROOT } from './config.js'
import { canonicalRoot } from './git-dirs.js'
import { jailCommand, jailTools } from './git-jail.js'

const exec = promisify(execFile)

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

/**
 * Config that keeps git from running a program a repository names: hooks, the fsmonitor, pagers,
 * editors, ssh and proxy commands, credential and askpass helpers and external diffs. No
 * transport is allowed either, so nothing a remote or a URL rewrite names is started.
 */
const NO_PROGRAMS = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.pager=cat',
  'core.editor=true',
  'sequence.editor=true',
  'core.sshCommand=false',
  'core.gitProxy=',
  'core.askPass=',
  'core.alternateRefsCommand=',
  'credential.helper=',
  'diff.external=',
  'protocol.allow=never',
].flatMap((setting) => ['-c', setting])

/** No system or user config, no prompt, pager or external diff from the environment either. */
function closedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dropped = ['GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS']
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !dropped.includes(name))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  }
}

/** Commands that format diffs, where an attribute can name a diff driver or a textconv program. */
const DIFFING = new Set(['diff', 'show', 'log'])

/** The arguments of a git command in a folder an agent can write to, where config is hostile. */
function guarded(cwd: string, args: readonly string[], files: readonly string[] = []): string[] {
  const [command = '', ...rest] = args
  const plainDiff = DIFFING.has(command) ? ['--no-ext-diff', '--no-textconv'] : []
  const included = files.flatMap((file) => ['-c', `include.path=${file}`])
  return [...included, ...NO_PROGRAMS, '-C', cwd, command, ...plainDiff, ...rest]
}

/** One git command in a folder an agent can write; reads unless `write`. */
interface AgentRun {
  cwd: string
  args: readonly string[]
  write?: boolean
  files?: readonly string[]
  folders?: readonly string[]
  env?: Readonly<Record<string, string>>
}

/** How an agent's git runs: in the jail (see git-jail.ts), or guarded where no jail can start. */
async function agentCommand(run: AgentRun): Promise<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> {
  const files = run.files ?? []
  const argv = guarded(run.cwd, run.args, files)
  const env = run.env ?? {}
  const tools = await jailTools()
  if (tools === null) {
    return { file: 'git', args: argv, env: closedEnv(env) }
  }
  const jailed = { cwd: run.cwd, argv, write: run.write === true, files, folders: run.folders ?? [], env }
  return jailCommand(jailed, tools.bwrap, tools.git)
}

async function runAgentGit(run: AgentRun, timeoutMs = 0): Promise<string> {
  const { file, args, env } = await agentCommand(run)
  const options = { maxBuffer: 16 * 1024 * 1024, env, timeout: timeoutMs, killSignal: 'SIGKILL' as const }
  const { stdout } = await exec(file, args, options)
  return stdout.trim()
}

/**
 * Runs git where an agent controls the repository: its config, hooks and attributes are input,
 * and what they name runs only in the jail. Local commands only; no remote is contacted.
 */
export async function agentGit(cwd: string, ...args: string[]): Promise<string> {
  return agentGitWithin(0, cwd, ...args)
}

/** Like agentGit, stopping git after `timeoutMs`; 0 waits for as long as it takes. */
export async function agentGitWithin(timeoutMs: number, cwd: string, ...args: string[]): Promise<string> {
  return runAgentGit({ cwd, args }, timeoutMs)
}

/** Like agentGitWithin, also reading config files the agent's git reads, such as its global one. */
export async function agentGitReading(
  timeoutMs: number,
  cwd: string,
  files: readonly string[],
  ...args: string[]
): Promise<string> {
  return runAgentGit({ cwd, args, files }, timeoutMs)
}

/** Like agentGit for a command that changes the repository, such as deleting a branch. */
export async function agentGitWrite(cwd: string, ...args: string[]): Promise<string> {
  return runAgentGit({ cwd, args, write: true })
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

/**
 * The main checkout a worktree belongs to, read from its `.git` files without running git; null
 * outside git, in a bare repo's worktree, or in the main checkout itself.
 */
export function mainCheckout(dir: string): string | null {
  const main = canonicalRoot(dir)
  return main === null || main === dir || !fs.existsSync(path.join(main, '.git')) ? null : main
}

/** Whether a checkout has uncommitted or untracked changes; false when git cannot tell. */
export async function hasLocalChanges(dir: string): Promise<boolean> {
  try {
    return (await agentGit(dir, 'status', '--porcelain')) !== ''
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
  const head = await agentGit(dir, 'rev-parse', 'HEAD')
  const branch = await agentGit(dir, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  const dirty = (await agentGit(dir, 'status', '--porcelain')) !== ''
  const remotes = await agentGit(dir, 'branch', '--remotes', '--contains', 'HEAD')
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

/**
 * Drops a checkout's record of one worktree whose folder is gone. `git worktree prune` would also
 * drop the worktrees agents keep in their sandbox homes, whose folders this side cannot see.
 */
export async function forgetWorktree(repoPath: string, dir: string): Promise<void> {
  if (!fs.existsSync(dir)) {
    // git fails when it holds no record of the folder, which leaves nothing to drop
    await agentGitWrite(repoPath, 'worktree', 'remove', '--force', dir).catch(() => '')
  }
}

/** Checks a removed worktree out again at its branch, or detached at its commit when that fails. */
export async function recreateWorktree(repoPath: string, dir: string, branch: string | null, head: string) {
  await forgetWorktree(repoPath, dir)
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
    await forgetWorktree(repoPath, dir)
  }
}

/**
 * Writes a checkout's uncommitted changes, untracked files included, as a binary patch to `file`.
 * A scratch index stages them, so the checkout's own index stays as it was.
 */
export async function saveUncommitted(dir: string, file: string): Promise<void> {
  const index = `${file}.index`
  const staged = { cwd: dir, write: true, folders: [path.dirname(index)], env: { GIT_INDEX_FILE: index } }
  try {
    await runAgentGit({ ...staged, args: ['read-tree', 'HEAD'] })
    await runAgentGit({ ...staged, args: ['add', '-A'] })
    const diff = await agentCommand({ ...staged, args: ['diff', '--cached', '--binary', 'HEAD'] })
    const child = spawn(diff.file, diff.args, { env: diff.env, stdio: ['ignore', 'pipe', 'ignore'] })
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
