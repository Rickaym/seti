import fs from 'node:fs'
import path from 'node:path'
import type { Mount, SandboxLayout } from './sandbox-mounts.js'

/** The variable a Codex agent's provider reads its key from: the key connection's placeholder. */
export const MODEL_KEY_ENV = 'SETI_MODEL_KEY'

/** Codex's home inside the agent's private home. */
export const CODEX_DIR = '.codex'

/** An empty folder in the task's state, shown read-only where Codex would read rules. */
export const EMPTY_DIR = 'empty'

/** Where Codex reads the machine's own settings, rules and skills. */
const HOST_CONFIG = '/etc/codex'

/**
 * Files in Codex's home that would change how a later session runs: its settings, the variables
 * it loads, its sign-in, the execution environments it sends commands to, and the instructions
 * it gives every session.
 */
const LOCKED_FILES = ['config.toml', '.env', 'auth.json', 'environments.toml', 'AGENTS.md', 'AGENTS.override.md']

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
 * Everything Codex or its shell reads that the agent could write to change how commands run or
 * are asked about, in this session or the next: empty and read-only. The machine's own Codex
 * settings are covered too, so only Seti's apply.
 */
export function codexLocks(layout: SandboxLayout, hostConfig = HOST_CONFIG): Mount[] {
  const empty = path.join(layout.taskDir, EMPTY_DIR)
  const { files, dirs } = codexMountPoints(layout.home)
  const host: Mount[] = fs.existsSync(hostConfig) ? [{ kind: 'ro-bind', src: empty, dest: hostConfig }] : []
  return [
    ...files.map((dest): Mount => ({ kind: 'mask', dest })),
    ...dirs.map((dest): Mount => ({ kind: 'ro-bind', src: empty, dest })),
    ...host,
  ]
}
