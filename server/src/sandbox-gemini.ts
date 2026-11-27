import fs from 'node:fs'
import path from 'node:path'
import { GEMINI_CONFIG_FILES } from './runtimes/gemini/launch.js'
import { EMPTY_DIR, EMPTY_FILE, SHELL_STARTUP, userInstructions } from './sandbox-codex.js'
import type { Mount, SandboxLayout } from './sandbox-mounts.js'

/** Gemini CLI's home inside the agent's private home, and its folder in a working folder. */
const GEMINI_DIR = '.gemini'

/** Where the sandbox shows Seti's settings and admin policy for Gemini CLI, read-only. */
export const GEMINI_CONFIG_MOUNT = '/run/seti-gemini'

/** The task's folder holding Seti's files for Gemini CLI, and an empty JSON object file. */
const CONFIG_DIR = 'gemini-config'
const EMPTY_JSON = 'empty.json'

/** Where Gemini CLI reads the machine's own settings and policies, which disable Seti's policy. */
const HOST_CONFIG = '/etc/gemini-cli'

/** JSON files in Gemini CLI's home: its settings, the folders it trusts and the hooks it trusts. */
const LOCKED_JSON = ['settings.json', 'trustedFolders.json', 'trusted_hooks.json']

/**
 * Text files in Gemini CLI's home: the variables it loads, the system prompt it can be pointed
 * at, and the instructions it gives every session.
 */
const LOCKED_TEXT = ['.env', 'system.md', 'GEMINI.md']

/**
 * Folders in Gemini CLI's home: policy rules that run calls unasked, extensions, skills, agents
 * and commands that add tool servers, hooks or instructions, and programs it would start.
 */
const LOCKED_DIRS = ['policies', 'extensions', 'skills', 'agents', 'commands', 'bin']

/** The home's own `.env`, which Gemini CLI reads whatever its settings say, and shared skills. */
const HOME_ENV = '.env'
const HOME_SKILLS = '.agents'

const INSTRUCTIONS = 'GEMINI.md'

/** The files and folders of a private home the sandbox covers; bwrap mounts only on what exists. */
const geminiMountPoints = (home: string): { files: string[]; dirs: string[] } => ({
  files: [
    ...[...LOCKED_JSON, ...LOCKED_TEXT].map((name) => path.join(home, GEMINI_DIR, name)),
    ...[HOME_ENV, ...SHELL_STARTUP].map((name) => path.join(home, name)),
  ],
  dirs: [...LOCKED_DIRS.map((name) => path.join(home, GEMINI_DIR, name)), path.join(home, HOME_SKILLS)],
})

/** The working folders' own Gemini CLI folders, whose settings run programs at start. */
const workFolderPoints = (layout: Pick<SandboxLayout, 'cwd' | 'dirs'>): string[] =>
  [layout.cwd, ...layout.dirs].map((dir) => path.join(dir, GEMINI_DIR))

/** What covers a file in the home: Seti's empty object, an empty file, or the user's rules. */
function coverOf(layout: SandboxLayout, dest: string): string {
  if (LOCKED_JSON.some((name) => dest === path.join(layout.home, GEMINI_DIR, name))) {
    return path.join(layout.taskDir, EMPTY_JSON)
  }
  if (dest === path.join(layout.home, GEMINI_DIR, INSTRUCTIONS)) {
    return userInstructions(layout) ?? path.join(layout.taskDir, EMPTY_FILE)
  }
  return path.join(layout.taskDir, EMPTY_FILE)
}

/**
 * Everything Gemini CLI or its shell reads that the agent or the repository could write to
 * change how calls run or are asked about: empty and read-only, in the home and in each working
 * folder. Seti's own settings and admin policy are shown read-only, and the machine's own Gemini
 * CLI folder is covered, so only Seti's apply. The one file with content is the user's own
 * CLAUDE.md, read-only, as Gemini CLI's global instructions.
 */
export function geminiLocks(layout: SandboxLayout, hostConfig = HOST_CONFIG): Mount[] {
  const empty = path.join(layout.taskDir, EMPTY_DIR)
  const { files, dirs } = geminiMountPoints(layout.home)
  const host: Mount[] = fs.existsSync(hostConfig) ? [{ kind: 'ro-bind', src: empty, dest: hostConfig }] : []
  return [
    ...files.map((dest): Mount => ({ kind: 'ro-bind', src: coverOf(layout, dest), dest })),
    ...[...dirs, ...workFolderPoints(layout)].map((dest): Mount => ({ kind: 'ro-bind', src: empty, dest })),
    { kind: 'ro-bind', src: path.join(layout.taskDir, CONFIG_DIR), dest: GEMINI_CONFIG_MOUNT },
    ...host,
  ]
}

/**
 * The task's covers and Seti's files for Gemini CLI, and the places in the private home and the
 * working folders its covers are mounted on. A working folder gets an empty `.gemini` folder
 * when it has none, so the cover holds even for one the agent makes while it runs.
 */
export function prepareGemini(dir: string, layout: Pick<SandboxLayout, 'cwd' | 'dirs'>): void {
  const { files, dirs } = geminiMountPoints(path.join(dir, 'home'))
  const config = path.join(dir, CONFIG_DIR)
  for (const folder of [path.join(dir, 'home', GEMINI_DIR), path.join(dir, EMPTY_DIR), config, ...dirs]) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  }
  for (const folder of workFolderPoints(layout)) {
    if (fs.lstatSync(folder, { throwIfNoEntry: false }) === undefined) {
      fs.mkdirSync(folder, { mode: 0o755 })
    }
  }
  for (const file of [...files, path.join(dir, EMPTY_FILE)]) {
    fs.closeSync(fs.openSync(file, 'a', 0o600))
  }
  fs.writeFileSync(path.join(dir, EMPTY_JSON), '{}\n', { mode: 0o600 })
  for (const [name, text] of Object.entries(GEMINI_CONFIG_FILES)) {
    fs.writeFileSync(path.join(config, name), text, { mode: 0o600 })
  }
}
