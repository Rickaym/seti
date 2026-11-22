import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { Task } from '@seti/shared'
import { connectionEnv, taskConnections } from './connection-egress.js'
import { planScope } from './memory-cap.js'
import { launch, type ScopeKind, type ScopePlan } from './memory-scope.js'
import { agentEnv, sandboxFor } from './session-options.js'
import type { TaskSandbox } from './task-sandbox.js'

/** A process a launcher started, with the pipes its runtime talks over. */
type LaunchedProcess = ChildProcess & { stdin: Writable; stdout: Readable }

/** What a runtime asks to start: its program, arguments, folder and environment. */
interface LaunchRequest {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string | undefined>
  signal: AbortSignal
}

/** Starts a runtime's process where Seti holds it. */
type Spawn = (request: LaunchRequest) => LaunchedProcess

/** How Seti starts a task's runtime process: its environment, and where it runs. */
export interface Launcher {
  readonly sandboxed: boolean
  /** The environment the process starts with, before the runtime adds its own. */
  readonly env: Record<string, string>
  /** Starts the process in the sandbox or memory scope; absent, the runtime starts it itself. */
  readonly spawn?: Spawn
}

const hasPipes = (child: ChildProcess): child is LaunchedProcess => child.stdin !== null && child.stdout !== null

const STDERR_TAIL = 4000

/** Drains stderr, which a runtime never reads from a process it did not start, and logs its end. */
function piped(child: ChildProcess, label: 'sandbox' | 'scope', taskId: string): LaunchedProcess {
  if (!hasPipes(child)) {
    throw new Error(`The ${label === 'sandbox' ? 'sandboxed' : 'scoped'} Claude Code process has no stdio pipes`)
  }
  let tail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = `${tail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL)
  })
  child.on('exit', (code) => {
    if (code !== null && code !== 0 && tail.trim() !== '') {
      process.stderr.write(`${label}: Claude Code of task ${taskId} exited with ${String(code)}: ${tail.trim()}\n`)
    }
  })
  return child
}

/** Runs a runtime's process in the sandbox, in a scope held to its memory cap if any. */
export const spawnInSandbox =
  (sandbox: TaskSandbox, taskId: string, scope: ScopePlan | null = null): Spawn =>
  (request) =>
    piped(
      sandbox.spawn(request.command, request.args, { env: request.env, signal: request.signal, scope }),
      'sandbox',
      taskId,
    )

/** Runs a runtime's process on the host in a scope held to the task's memory cap. */
const spawnInScope =
  (scope: ScopePlan): Spawn =>
  (request) =>
    piped(
      launch(scope, request.command, request.args, (command, args) =>
        spawn(command, args, {
          cwd: request.cwd,
          env: { ...request.env, XDG_RUNTIME_DIR: scope.host.runtimeDir },
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: request.signal,
        }),
      ),
      'scope',
      scope.taskId,
    )

/**
 * Where a task's process starts: in its sandbox, else on the host in the scope of its kind, with
 * the task's connections in its environment when asked.
 */
export async function taskLauncher(task: Task, kind: ScopeKind, connections: boolean): Promise<Launcher> {
  const sandbox = await sandboxFor(task)
  const scope = await planScope(task.id, kind)
  if (sandbox !== null) {
    return { sandboxed: true, env: sandbox.env, spawn: spawnInSandbox(sandbox, task.id, scope) }
  }
  const env = agentEnv(scope?.cap ?? null)
  return {
    sandboxed: false,
    env: connections ? { ...env, ...connectionEnv(await taskConnections(task)) } : env,
    ...(scope === null ? {} : { spawn: spawnInScope(scope) }),
  }
}
