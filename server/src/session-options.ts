import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { McpServerConfig, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { extraDirs, type MemoryCap, type Task } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { taskAws } from './aws-access.js'
import { CLAUDE_HOME, CREDENTIALS, DATABASE_URL, REDIS_URL, SETI_HOME } from './config.js'
import { planScope } from './memory-cap.js'
import { launch, type ScopePlan } from './memory-scope.js'
import { memoryEnv } from './node-heap.js'
import type { GuardScope } from './permission-guard.js'
import { builtInRules, composeRules, type PermissionSettings } from './permission-policy.js'
import { taskPluginConfigs } from './plugins.js'
import { mcpTargets } from './sandbox-mcp.js'
import { secretDenyRules, setiHomePaths, unsandboxedHookRules, type SandboxContext } from './sandbox.js'
import { sharedToolFolders, TOOL_SERVER } from './shared-tools.js'
import { keyStamp, sshStamp } from './ssh-files.js'
import { profiles } from './store/credentials.js'
import { permissionRules } from './store/permissions.js'
import { sandboxPolicy } from './store/sandbox.js'
import { profileStamp } from './task-credentials.js'
import { taskSandbox, type TaskSandbox } from './task-sandbox.js'
import { hostToolShell, toolShellEnv } from './tool-shell.js'
import { workspaceDir } from './workspace/dir.js'

/**
 * Returns extra system prompt text for a task, or null when it has nothing to add.
 * @public
 */
export type ContextProvider = (taskId: string) => string | null | Promise<string | null>

const contextProviders: ContextProvider[] = []

/** @public */
export function registerContextProvider(provider: ContextProvider): void {
  contextProviders.push(provider)
}

/**
 * Builds MCP servers that run inside Seti's own process for a task's session, keyed by name.
 * @public
 */
export type SessionMcpServers = (task: Task) => Record<string, McpServerConfig>

const sessionMcpFactories: SessionMcpServers[] = []

/** @public */
export function registerSessionMcpServers(factory: SessionMcpServers): void {
  sessionMcpFactories.push(factory)
}

export const inProcessServers = (task: Task): Record<string, McpServerConfig> =>
  Object.assign({}, ...sessionMcpFactories.map((factory) => factory(task))) as Record<string, McpServerConfig>

export async function systemAppend(taskId: string): Promise<string> {
  const extra = await Promise.all(contextProviders.map(async (provider) => provider(taskId)))
  return extra.filter((text) => text !== null).join('\n\n')
}

/** The server's environment for an unsandboxed process tree, sized to the cap that holds it. */
export function agentEnv(cap: MemoryCap | null): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ANTHROPIC_API_KEY') {
      env[key] = value
    }
  }
  return { ...env, ...hostLimitsEnv(cap) }
}

/** The heap size and tool prefix of a process tree on the host, under the cap that holds it. */
export const hostLimitsEnv = (cap: MemoryCap | null): Record<string, string> => ({
  ...memoryEnv(process.env.NODE_OPTIONS, cap),
  ...(cap === null ? {} : toolShellEnv(hostToolShell())),
})

/** The folders besides cwd the agent works in: its repos and dirs, then its Seti workspace. */
export const workingDirs = (task: Task) =>
  [...new Set([...extraDirs(task), workspaceDir(task.id)])].filter((dir) => dir !== task.cwd)

/** The database and cache socket directories, which no sandbox mounts. */
function socketDirs(): string[] {
  const database = new URL(DATABASE_URL).searchParams.get('host')
  const dirs = [database ?? '', REDIS_URL.startsWith('/') ? path.dirname(REDIS_URL) : '']
  return dirs.filter((dir) => dir.startsWith('/') && fs.existsSync(dir)).map((dir) => fs.realpathSync(dir))
}

/** The per-user credentials root systemd fills, and the server's own directory when elsewhere. */
function credentialDirs(): string[] {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${String(os.userInfo().uid)}`
  const root = path.join(runtime, 'credentials')
  const own = CREDENTIALS.dev ? null : CREDENTIALS.dir
  return own === null || own.startsWith(`${root}/`) ? [root] : [root, own]
}

export function sandboxContext(): SandboxContext {
  return {
    home: os.homedir(),
    setiHome: SETI_HOME,
    claudeHome: CLAUDE_HOME,
    sockets: socketDirs(),
    credentials: credentialDirs(),
  }
}

/** Names the task in its process's environment, so the resource sampler can tell processes apart. */
export const TASK_ID_ENV = 'SETI_TASK_ID'

/** The task's sandbox, with its plugins and shared tools read-only, or null when it runs without. */
export async function sandboxFor(task: Task): Promise<TaskSandbox | null> {
  const policy = await sandboxPolicy.get()
  if (!(policy.enabled && task.sandbox)) {
    return null
  }
  const plugins = (await taskPluginConfigs(task.id)).map((plugin) => plugin.path)
  const tools = await sharedToolFolders(task)
  const readOnly = tools.length === 0 ? plugins : [...plugins, TOOL_SERVER, ...tools]
  const memory = (await planScope(task.id, 'agent'))?.cap ?? null
  return taskSandbox(task, { ctx: sandboxContext(), policy, readOnly, memory })
}

const hasPipes = (child: ChildProcess): child is ChildProcess & { stdin: Writable; stdout: Readable } =>
  child.stdin !== null && child.stdout !== null

const STDERR_TAIL = 4000

/** Drains stderr, which the SDK never reads from a process it did not start, and logs its end. */
function piped(child: ChildProcess, label: 'sandbox' | 'scope', taskId: string): SpawnedProcess {
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

/** Runs the SDK's Claude Code process in the sandbox, in a scope held to its memory cap if any. */
export const spawnInSandbox =
  (sandbox: TaskSandbox, taskId: string, scope: ScopePlan | null = null) =>
  (options: SpawnOptions): SpawnedProcess =>
    piped(
      sandbox.spawn(options.command, options.args, { env: options.env, signal: options.signal, scope }),
      'sandbox',
      taskId,
    )

/** Runs the SDK's Claude Code process on the host in a scope held to the task's memory cap. */
export const spawnInScope =
  (scope: ScopePlan) =>
  (options: SpawnOptions): SpawnedProcess =>
    piped(
      launch(scope, options.command, options.args, (command, args) =>
        spawn(command, args, {
          cwd: options.cwd,
          env: { ...options.env, XDG_RUNTIME_DIR: scope.host.runtimeDir },
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: options.signal,
        }),
      ),
      'scope',
      scope.taskId,
    )

/** The ssh hosts a task can use, with the hosts, keys and host keys its files render. */
async function sshSetup(taskId: string) {
  const reach = await taskSsh(taskId)
  return reach.usable.length === 0
    ? null
    : {
        hosts: reach.usable,
        rendered: reach.hosts,
        keys: await keyStamp(reach.hosts),
        known: await sshStamp(reach.knownHosts),
      }
}

/** What a task's sandbox is made of; a process in it needs a new sandbox when this changes. */
export const sandboxStamp = async (task: Task) => ({
  ...(await sandboxPolicy.get()),
  updated_at: null,
  task: task.sandbox,
  home: task.home_access,
  profile: await profileStamp(task),
  mcp: mcpTargets(),
  aws: (await taskAws(task.id)) ? ((await profiles.get(task.profile_id))?.aws.region ?? null) : null,
  ssh: await sshSetup(task.id),
})

const GUARDED_HOME = ['.ssh', '.aws', '.config']

/** Edits under the home folders that hold credentials and settings, for every agent. */
const guardedEdits = (home: string) =>
  GUARDED_HOME.flatMap((dir) => [`Edit(/${path.join(home, dir)})`, `Edit(/${path.join(home, dir)}/**)`])

/**
 * The allow, ask and deny rules the task's agent runs with: built-in, edits in its workspace,
 * global and its own, with the deny rules that keep credentials out of every task and hooks out
 * of sandboxed ones.
 */
export async function permissionSettings(task: Task): Promise<PermissionSettings> {
  const policy = await sandboxPolicy.get()
  const sandboxed = policy.enabled && task.sandbox
  const ctx = sandboxContext()
  const secrets = [...secretDenyRules(policy, ctx), ...guardedEdits(ctx.home)]
  return composeRules({
    builtIn: builtInRules(),
    sandboxed,
    stored: [
      { behavior: 'allow', rule: `Edit(/${workspaceDir(task.id)}/**)` },
      ...(await permissionRules.list(null)),
      ...(await permissionRules.list(task.id)),
    ],
    fixedDeny: sandboxed ? [...secrets, ...unsandboxedHookRules()] : secrets,
  })
}

const GUARDED_SETI = ['credentials', 'dev-credentials']

/** Where the task's agent may remove trees, and the credentials it never writes under. */
export function guardScope(task: Task, sandboxed: boolean): GuardScope {
  const ctx = sandboxContext()
  return {
    home: ctx.home,
    sandboxed,
    roots: [task.cwd, ...extraDirs(task), workspaceDir(task.id)],
    protectedDirs: [
      ...GUARDED_HOME.map((dir) => path.join(ctx.home, dir)),
      ...setiHomePaths(ctx).flatMap((home) => GUARDED_SETI.map((dir) => path.join(home, dir))),
    ],
  }
}
