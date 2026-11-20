import path from 'node:path'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { extraDirs, type Task } from '@seti/shared'
import type { ProbeLaunch } from './capabilities.js'
import { tasks } from './db.js'
import { taskPluginConfigs } from './plugins.js'
import { sandboxFor } from './session-options.js'
import { spawnInSandbox } from './session-realise.js'
import { sandboxPolicy } from './store/sandbox.js'

const within = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep)

const USER_ONLY: ProbeLaunch = { settingSources: ['user'] }

/** The probe processes running in each task's sandbox now. */
const running = new Map<string, Set<SpawnedProcess>>()

/** Starts the probe's process in the sandbox and keeps hold of it until it exits. */
function tracked(taskId: string, spawn: (options: SpawnOptions) => SpawnedProcess) {
  return (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options)
    const mine = running.get(taskId) ?? new Set<SpawnedProcess>()
    running.set(taskId, mine.add(child))
    child.once('exit', () => {
      mine.delete(child)
    })
    return child
  }
}

/**
 * Ends the probes running in a task's sandbox and waits for them to exit, so its sandbox state
 * and folders can be removed.
 */
export async function stopTaskProbes(taskId: string): Promise<void> {
  const children = [...(running.get(taskId) ?? [])]
  running.delete(taskId)
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null) {
        return
      }
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve()
        })
      })
      child.kill('SIGKILL')
      await exited
    }),
  )
}

/** The probe as the agent's own session starts: inside its sandbox, with its plugins. */
async function inSandbox(task: Task): Promise<ProbeLaunch> {
  try {
    const sandbox = await sandboxFor(task)
    if (sandbox === null) {
      return USER_ONLY
    }
    return {
      settingSources: ['user', 'project', 'local'],
      env: sandbox.env,
      plugins: await taskPluginConfigs(task.id),
      spawnClaudeCodeProcess: tracked(task.id, spawnInSandbox(sandbox, task.id)),
    }
  } catch (e) {
    process.stderr.write(
      `capability probe: no sandbox for task ${task.id}: ${e instanceof Error ? e.message : String(e)}\n`,
    )
    return USER_ONLY
  }
}

/**
 * How Seti probes a directory that a sandboxed agent, archived or not, can write. Project
 * settings there start hooks and the servers of `.mcp.json`, which the agent could have written,
 * so the host never loads them: the directory an agent works in is probed inside that agent's
 * sandbox, and any other folder of a sandboxed agent with the user's settings alone. Null for
 * every other directory, which the host probes as before.
 */
export async function sandboxedProbeLaunch(cwd: string): Promise<ProbeLaunch | null> {
  if (!(await sandboxPolicy.get()).enabled) {
    return null
  }
  const sandboxed = (await tasks.listAll()).filter((task) => task.sandbox)
  const worker = sandboxed.find((task) => task.cwd === cwd && task.archived_at === null)
  if (worker !== undefined) {
    return inSandbox(worker)
  }
  const reachable = sandboxed.some((task) => [task.cwd, ...extraDirs(task)].some((dir) => within(cwd, dir)))
  return reachable ? USER_ONLY : null
}
