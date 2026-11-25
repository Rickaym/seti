import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { sandboxed } from './aws-access.js'
import { sandboxDirOf, usedDirs, within } from './owned-dirs.js'

/** Where an agent's git finds a folder it names, and the global config it reads, on the host. */
export interface AgentGitView {
  folder: (dir: string) => string
  globals: string[]
}

const SANDBOX_TMP = '/tmp'

/**
 * How the host sees an agent's git. Outside a sandbox: as named, with the user's global config.
 * In one: the agent's folders and shared home folders as named; its private /tmp and home, global
 * config included, from the task's sandbox folder, so a folder there never reads as the host's.
 */
export async function agentGitView(task: Task): Promise<AgentGitView> {
  const home = os.homedir()
  if (!(await sandboxed(task))) {
    const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')
    return { folder: (dir) => dir, globals: [path.join(xdg, 'git', 'config'), path.join(home, '.gitconfig')] }
  }
  const box = sandboxDirOf(task.id)
  const own = path.join(box, 'home')
  const bound = usedDirs(task)
  const folder = (dir: string) => {
    if (bound.some((root) => within(dir, root))) {
      return dir
    }
    if (within(dir, SANDBOX_TMP)) {
      return path.join(box, 'tmp', path.relative(SANDBOX_TMP, dir))
    }
    if (!within(dir, home)) {
      return dir
    }
    const top = path.relative(home, dir).split(path.sep)[0] ?? ''
    const shared = task.home_access && top !== '' && !top.startsWith('.') && fs.existsSync(path.join(home, top))
    return shared ? dir : path.join(own, path.relative(home, dir))
  }
  return { folder, globals: [path.join(own, '.config', 'git', 'config'), path.join(own, '.gitconfig')] }
}
