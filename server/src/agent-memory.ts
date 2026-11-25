import fs from 'node:fs'
import path from 'node:path'
import { extraDirs, type Task } from '@seti/shared'
import { CLAUDE_HOME, WORKTREE_ROOT } from './config.js'
import { dreamsOf } from './runtimes/capabilities.js'
import { memoryDirs } from './sandbox-mounts.js'
import { sandboxContext } from './session-options.js'

/** The memory folders of the agent's checkouts that exist, relative to the runtime's home. */
function checkoutMemory(task: Task): string[] {
  const trust = { cwd: task.cwd, dirs: extraDirs(task), homeAccess: task.home_access, worktreeRoot: WORKTREE_ROOT }
  return memoryDirs(trust).filter((dir) => fs.existsSync(path.join(CLAUDE_HOME, dir)))
}

const inSandbox = (dir: string) => path.join(sandboxContext().home, '.claude', dir)

/** The checkouts' memory folders a sandboxed agent sees read-only, as its sandbox shows them. */
export const sharedMemory = (task: Task): string[] => checkoutMemory(task).map(inSandbox)

/**
 * Where a sandboxed agent finds the memory every session of its repositories shares, read-only:
 * its sessions keep and load their own, so without this line they would not know it is there.
 */
export function sharedMemoryLines(task: Task): string[] {
  if (dreamsOf(task.runtime) === null) {
    return []
  }
  const indexes = checkoutMemory(task)
    .map((dir) => path.join(dir, 'MEMORY.md'))
    .filter((index) => fs.existsSync(path.join(CLAUDE_HOME, index)))
    .map(inSandbox)
  if (indexes.length === 0) {
    return []
  }
  return [
    `Your memory is your own. Memory that other sessions of your repository keep is read-only to you; its index: ${indexes.join(', ')}. ` +
      'Read it when earlier work there may help, and save what you learn in your own memory.',
  ]
}
