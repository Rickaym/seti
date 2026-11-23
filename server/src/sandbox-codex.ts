import path from 'node:path'
import type { Mount, SandboxLayout } from './sandbox-mounts.js'

/** The variable a Codex agent's provider reads its key from: the key connection's placeholder. */
export const MODEL_KEY_ENV = 'SETI_MODEL_KEY'

/** Codex's home inside the agent's private home. */
export const CODEX_DIR = '.codex'

/** An empty folder in the task's state, shown read-only where Codex would read rules. */
export const EMPTY_DIR = 'empty'

/**
 * Files in Codex's home that would change how a later session runs: its settings, the variables
 * it loads, and command rules that run commands without asking. The agent cannot write them.
 */
export function codexLocks(layout: SandboxLayout): Mount[] {
  const home = path.join(layout.home, CODEX_DIR)
  return [
    { kind: 'mask', dest: path.join(home, 'config.toml') },
    { kind: 'mask', dest: path.join(home, '.env') },
    { kind: 'ro-bind', src: path.join(layout.taskDir, EMPTY_DIR), dest: path.join(home, 'rules') },
  ]
}
