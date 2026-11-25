import fs from 'node:fs'
import path from 'node:path'
import type { Mount, SandboxLayout } from './sandbox-mounts.js'

/** The variable a Codex agent's provider reads its key from: the key connection's placeholder. */
export const MODEL_KEY_ENV = 'SETI_MODEL_KEY'

/** Codex's home inside the agent's private home. */
export const CODEX_DIR = '.codex'

/** An empty folder in the task's state, shown read-only where Codex would read rules. */
export const EMPTY_DIR = 'empty'

/** An empty file in the task's state, shown read-only over each file Codex reads settings from. */
export const EMPTY_FILE = 'empty-file'

/** The user's own instructions for every Claude Code agent, which Codex agents read as theirs. */
const USER_INSTRUCTIONS = 'CLAUDE.md'

/** Where Codex reads the instructions it gives every session. */
const CODEX_INSTRUCTIONS = 'AGENTS.md'

/** Where Codex reads the machine's own settings, rules and skills. */
const HOST_CONFIG = '/etc/codex'

/**
 * Files in Codex's home that would change how a later session runs: its settings, the variables
 * it loads, its sign-in, the execution environments it sends commands to, and the instructions
 * it gives every session.
 */
const LOCKED_FILES = ['config.toml', '.env', 'auth.json', 'environments.toml', CODEX_INSTRUCTIONS, 'AGENTS.override.md']

/** Folders in Codex's home: command rules that run commands without asking, and agent roles. */
const LOCKED_DIRS = ['rules', 'agents']

/** What a shell started in the private home reads before every command Codex runs. */
const SHELL_STARTUP = [
  ...['.zshenv', '.zprofile', '.zlogin', '.zlogout', '.zshrc'].flatMap((name) => [name, `${name}.zwc`]),
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.bashrc',
  '.bash_logout',
]

/** The home's skills folder, which Codex would offer every session. */
const HOME_SKILLS = '.agents'

/** The files and folders of a private home the sandbox covers; bwrap mounts only on what exists. */
export const codexMountPoints = (home: string): { files: string[]; dirs: string[] } => ({
  files: [
    ...LOCKED_FILES.map((name) => path.join(home, CODEX_DIR, name)),
    ...SHELL_STARTUP.map((name) => path.join(home, name)),
  ],
  dirs: [...LOCKED_DIRS.map((name) => path.join(home, CODEX_DIR, name)), path.join(home, HOME_SKILLS)],
})

/**
 * The user's own CLAUDE.md when it is a file, which a Codex agent reads as its global AGENTS.md;
 * none for a bare session, which gets none of the user's files.
 */
function userInstructions(layout: SandboxLayout): string | null {
  if (layout.maintenance?.bare === true) {
    return null
  }
  const file = path.join(layout.claudeHome, USER_INSTRUCTIONS)
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true ? file : null
}

/**
 * Everything Codex or its shell reads that the agent could write to change how commands run or
 * are asked about, in this session or the next: empty and read-only. The machine's own Codex
 * settings are covered too, so only Seti's apply. The one file with content is the user's own
 * CLAUDE.md, read-only, as Codex's global instructions.
 */
export function codexLocks(layout: SandboxLayout, hostConfig = HOST_CONFIG): Mount[] {
  const empty = path.join(layout.taskDir, EMPTY_DIR)
  const blank = path.join(layout.taskDir, EMPTY_FILE)
  const { files, dirs } = codexMountPoints(layout.home)
  const host: Mount[] = fs.existsSync(hostConfig) ? [{ kind: 'ro-bind', src: empty, dest: hostConfig }] : []
  const instructions = path.join(layout.home, CODEX_DIR, CODEX_INSTRUCTIONS)
  const own = userInstructions(layout)
  return [
    // Not a mask: /dev/null in a user namespace cannot be opened, and Codex fails reading it.
    ...files.map((dest): Mount => ({ kind: 'ro-bind', src: dest === instructions ? (own ?? blank) : blank, dest })),
    ...dirs.map((dest): Mount => ({ kind: 'ro-bind', src: empty, dest })),
    ...host,
  ]
}
