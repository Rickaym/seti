import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { binaryPath } from './binaries.js'
import { CLAUDE_HOME, SETI_HOME } from './config.js'
import { repoTop } from './git-dirs.js'
import { bwrapArgs } from './sandbox-bwrap.js'
import { systemMounts, type Mount } from './sandbox-mounts.js'

const exec = promisify(execFile)

/** One git command for the jail: where it runs and what it may see besides the repository. */
export interface JailedGit {
  cwd: string
  /** The arguments after `git`. */
  argv: readonly string[]
  /** Mounts the repository and `folders` writable, for a command that changes them. */
  write: boolean
  /** Config files git reads besides the repository's, such as an agent's global one. */
  files: readonly string[]
  /** Folders outside the repository the command uses, such as a scratch index's. */
  folders: readonly string[]
  /** Variables for git, such as GIT_INDEX_FILE. */
  env: Readonly<Record<string, string>>
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep)

const SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib64']

/** Why the jail must not mount a folder: it holds the home folder, Seti's data or Claude's. */
function heldProblem(folder: string): string | null {
  const held = [os.homedir(), SETI_HOME, CLAUDE_HOME].find((dir) => within(dir, folder))
  return held === undefined ? null : `${folder} holds ${held}`
}

/** The repository's top and git folders around `cwd`; an empty folder stands in outside one. */
function repoMounts(cwd: string, write: boolean): Mount[] {
  const found = repoTop(cwd)
  if (found === null) {
    return [{ kind: 'tmpfs', dest: cwd }]
  }
  const folders = [found.top, ...(found.git.linked ? [found.git.common] : [])]
  return folders.map((folder) => {
    const problem = heldProblem(folder)
    if (problem !== null) {
      throw new Error(`git does not run in ${cwd}: its repository ${problem}`)
    }
    return { kind: write ? 'bind' : 'ro-bind', src: folder, dest: folder }
  })
}

/** The mounts of the jail for one command, the git program's own folder included. */
function jailMounts(run: JailedGit, git: string): Mount[] {
  const own = path.dirname(git)
  const program: Mount[] = SYSTEM.some((dir) => within(own, dir)) ? [] : [{ kind: 'ro-bind', src: own, dest: own }]
  const files = run.files.filter((file) => fs.existsSync(file))
  return [
    ...systemMounts(),
    { kind: 'tmpfs', dest: '/tmp' },
    ...program,
    ...repoMounts(path.resolve(run.cwd), run.write),
    ...run.folders.map((dir): Mount => ({ kind: run.write ? 'bind' : 'ro-bind', src: dir, dest: dir })),
    ...files.map((file): Mount => ({ kind: 'ro-bind', src: file, dest: file })),
  ]
}

/** The whole environment of git in the jail: none of the server's variables reach it. */
function jailEnv(git: string, extra: Readonly<Record<string, string>>): Record<string, string> {
  return {
    PATH: `${path.dirname(git)}:/usr/bin:/bin`,
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  }
}

/**
 * The program, arguments and environment that run one git command in the jail. Git that Seti
 * runs in a folder an agent can write never runs on the host: a repository's config and
 * attributes name programs that no fixed `-c` list switches off (filter drivers under any name,
 * diff and merge drivers, signing programs, every submodule's own config). In the jail whatever
 * the repository names reaches no more than the agent that wrote it: no network, no home, no
 * Seti data and no server environment; the system folders and the repository's own folders,
 * read-only unless the command writes.
 */
export function jailCommand(run: JailedGit, bwrap: string, git: string) {
  const args = [...bwrapArgs(jailMounts(run, git), '/'), '--cap-drop', 'ALL', git, ...run.argv]
  return { file: bwrap, args, env: jailEnv(git, run.env) }
}

const RETRY_MS = 60_000

let ready: { bwrap: string; git: string } | null = null
let checkedAt = -Infinity
let reported = false

/**
 * bwrap and git when the jail starts on this host, checked once and again a minute after a
 * failure. Where bwrap cannot start the jail it cannot start an agent's sandbox either, so no
 * agent runs sandboxed and git on the host reaches nothing an agent could not already.
 */
export async function jailTools(): Promise<{ bwrap: string; git: string } | null> {
  if (ready !== null || performance.now() - checkedAt < RETRY_MS) {
    return ready
  }
  checkedAt = performance.now()
  const bwrap = binaryPath('bwrap')
  const git = binaryPath('git')
  if (bwrap === null || git === null) {
    return null
  }
  const probe = jailCommand(
    { cwd: '/tmp', argv: ['--version'], write: false, files: [], folders: [], env: {} },
    bwrap,
    git,
  )
  try {
    await exec(probe.file, probe.args, { env: probe.env, timeout: 15_000 })
    ready = { bwrap, git }
  } catch (e) {
    if (!reported) {
      reported = true
      process.stderr.write(`git: agents' repositories are read without a jail; bwrap cannot start: ${String(e)}\n`)
    }
  }
  return ready
}
