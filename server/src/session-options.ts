import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type {
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  Options,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { extraDirs, type MemoryCap, type SandboxPolicy, type Task } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { audit } from './audit.js'
import { taskAws } from './aws-access.js'
import { bypassLaunch, permissionModeOf } from './bypass-mode.js'
import { hostLoginKey } from './claude-logins.js'
import { compactHook, compactSetup, effectiveCompact } from './compact.js'
import { CLAUDE_HOME, CREDENTIALS, DATABASE_URL, REDIS_URL, SETI_HOME } from './config.js'
import { connectionEnv, taskConnections } from './connection-egress.js'
import { borrowedStamp, taskBorrowedServers } from './mcp-borrowed.js'
import { taskDeniedServers } from './mcp-selection.js'
import { tokenServers } from './mcp-sign-in.js'
import { planScope } from './memory-cap.js'
import { launch, type ScopePlan } from './memory-scope.js'
import { memoryEnv } from './node-heap.js'
import { bashGuard, type GuardScope } from './permission-guard.js'
import { builtInRules, composeRules, type PermissionSettings } from './permission-policy.js'
import { canUseToolFor } from './permission-requests.js'
import { taskPluginConfigs } from './plugins.js'
import { mcpTargets, signedInServers } from './sandbox-mcp.js'
import { sandboxHooks, secretDenyRules, setiHomePaths, unsandboxedHookRules, type SandboxContext } from './sandbox.js'
import { redactSecrets } from './scrub.js'
import { keyStamp, sshStamp } from './ssh-files.js'
import { allowedFor } from './store/change-requests.js'
import { profiles } from './store/credentials.js'
import { permissionRules } from './store/permissions.js'
import { sandboxPolicy } from './store/sandbox.js'
import { profileStamp } from './task-credentials.js'
import { taskSandbox, type TaskSandbox } from './task-sandbox.js'
import { hostToolShell, toolShellEnv } from './tool-shell.js'
import { workspaceDir, WORKSPACE_ENV } from './workspace/dir.js'

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

const inProcessServers = (task: Task): Record<string, McpServerConfig> =>
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

/** Everything a session's process starts with that needs a new process when it changes. */
async function sessionSetup(task: Task) {
  const dirs = workingDirs(task)
  return {
    cwd: task.cwd,
    ...(dirs.length === 0 ? {} : { additionalDirectories: dirs }),
    permissionMode: permissionModeOf(task),
    ...bypassLaunch(task),
    plugins: await taskPluginConfigs(task.id),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: await systemAppend(task.id) },
  } satisfies Options
}

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

/**
 * Claude Code stops a background command at its `timeout`, 30 minutes unless the agent sets one,
 * and caps that at 2 hours; this raises the cap to a day.
 */
const BACKGROUND_LIMIT = { BASH_MAX_TIMEOUT_MS: String(24 * 60 * 60_000) }

/**
 * Claude Code leaves its own todo tools (TaskCreate and the rest, TodoWrite before them) out for
 * newer models unless this is set; the agent's todo list in Seti is read from those calls.
 */
const TODO_TOOLS = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }

/** Claude Code runs Bash commands in the login shell, often zsh; agents write bash, so use bash. */
const BASH_SHELL = { CLAUDE_CODE_SHELL: '/bin/bash', SHELL: '/bin/bash' }

/** The task's sandbox, with its local plugins mounted read-only, or null when it runs without. */
export async function sandboxFor(task: Task): Promise<TaskSandbox | null> {
  const policy = await sandboxPolicy.get()
  if (!(policy.enabled && task.sandbox)) {
    return null
  }
  const plugins = (await taskPluginConfigs(task.id)).map((plugin) => plugin.path)
  const memory = (await planScope(task.id, 'agent'))?.cap ?? null
  return taskSandbox(task, { ctx: sandboxContext(), policy, readOnly: plugins, memory })
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

type SessionSetup = Awaited<ReturnType<typeof sessionSetup>>

/** What a task's sandbox is made of; a process in it needs a new sandbox when this changes. */
export const sandboxStamp = async (task: Task) => ({
  ...(await sandboxPolicy.get()),
  updated_at: null,
  task: task.sandbox,
  profile: await profileStamp(task),
  mcp: mcpTargets(),
  aws: (await taskAws(task.id)) ? ((await profiles.get(task.profile_id))?.aws.region ?? null) : null,
  ssh: await sshSetup(task.id),
})

/** The mode is left out: Seti switches a running process's mode without a restart. */
const keyOf = async (task: Task, { permissionMode: _mode, ...setup }: SessionSetup) =>
  JSON.stringify({
    ...setup,
    mcp_denied: await taskDeniedServers(task.id),
    mcp_borrowed: borrowedStamp(await taskBorrowedServers(task)),
    mcp_signed_in: [...signedInServers()].toSorted((a, b) => a.localeCompare(b, 'en')),
    mcp_tokens: [...tokenServers()].toSorted((a, b) => a.localeCompare(b, 'en')),
    seti_control: task.seti_control,
    compact: compactSetup(await effectiveCompact(task.id)),
    claude_login: hostLoginKey(),
    sandbox: await sandboxStamp(task),
  })

/** Compares the setup a process started with to what the task needs now. */
export const setupKey = async (task: Task) => keyOf(task, await sessionSetup(task))

/** Claude Code leaves out the MCP servers a task turned off, whatever config names them. */
const deniedMcpSettings = (names: readonly string[]) => ({
  deniedMcpServers: names.map((serverName) => ({ serverName })),
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
function guardScope(task: Task, sandboxed: boolean): GuardScope {
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

const COMMAND_CHARS = 500

/** The guard's refusals go to the audit log, so the user sees what an agent tried. */
const auditRefusal = (task: Task) => async (command: string, reason: string) => {
  const shown = redactSecrets(command).slice(0, COMMAND_CHARS)
  await audit.record({
    actor: 'system',
    kind: 'task.permission_denied',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Refused a command of task "${task.title}": ${reason}`,
    detail: { title: task.title, tool: 'Bash', command: shown, guard: true },
  })
}

/** Hooks of every task: the shell guard, and for a sandboxed one the WebFetch allowlist too. */
function sessionHooks(task: Task, policy: SandboxPolicy | null): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const guard = bashGuard(guardScope(task, policy !== null), auditRefusal(task))
  const sandbox = policy === null ? [] : (sandboxHooks(async () => allowedFor(task.id)).PreToolUse ?? [])
  return { PreToolUse: [guard, ...sandbox] }
}

/** Rules for every task, a sandbox's launcher and env, else the borrowed MCP servers. */
async function sandboxOptions(task: Task) {
  const policy = await sandboxPolicy.get()
  const settings = {
    ...deniedMcpSettings(await taskDeniedServers(task.id)),
    permissions: await permissionSettings(task),
  }
  const sandbox = await sandboxFor(task)
  const scope = await planScope(task.id, 'agent')
  if (sandbox === null) {
    const borrowed = (await taskBorrowedServers(task)) as Record<string, McpServerConfig>
    return {
      settings,
      hooks: sessionHooks(task, null),
      env: { ...agentEnv(scope?.cap ?? null), ...connectionEnv(await taskConnections(task)) },
      ...(Object.keys(borrowed).length === 0 ? {} : { mcpServers: borrowed }),
      ...(scope === null ? {} : { spawnClaudeCodeProcess: spawnInScope(scope) }),
    } satisfies Options
  }
  return {
    settings,
    hooks: sessionHooks(task, policy),
    env: sandbox.env,
    spawnClaudeCodeProcess: spawnInSandbox(sandbox, task.id, scope),
  } satisfies Options
}

/** The borrowed servers of an unsandboxed task and the in-process ones, when there are any. */
function withInProcessServers(task: Task, servers: Record<string, McpServerConfig> = {}) {
  const all = { ...servers, ...inProcessServers(task) }
  return Object.keys(all).length === 0 ? {} : { mcpServers: all }
}

async function optionsOf(task: Task, abortController: AbortController, setup: SessionSetup): Promise<Options> {
  const sandbox = await sandboxOptions(task)
  const compact = compactSetup(await effectiveCompact(task.id))
  return {
    ...setup,
    ...(task.session_id === null ? {} : { resume: task.session_id }),
    enableFileCheckpointing: true,
    title: task.title,
    abortController,
    canUseTool: canUseToolFor(task.id, abortController.signal),
    perTaskStopAffordance: true,
    settingSources: ['user', 'project', 'local'],
    ...sandbox,
    ...withInProcessServers(task, 'mcpServers' in sandbox ? sandbox.mcpServers : {}),
    settings: { ...sandbox.settings, ...compact.settings },
    hooks: { ...sandbox.hooks, PreCompact: [compactHook(task.id)] },
    env: {
      ...BACKGROUND_LIMIT,
      ...TODO_TOOLS,
      ...sandbox.env,
      ...BASH_SHELL,
      ...compact.env,
      [TASK_ID_ENV]: task.id,
      [WORKSPACE_ENV]: workspaceDir(task.id),
    },
  }
}

/** The options a task's Claude Code process starts with, resuming the task's session if any. */
export const sessionOptions = async (task: Task, abortController: AbortController) =>
  optionsOf(task, abortController, await sessionSetup(task))

/**
 * The options a process starts with and the setupKey of what it got, from one read of the setup.
 * A setting that changed while the options were read leaves no key, so the next turn restarts.
 */
export async function sessionStart(task: Task, abortController: AbortController) {
  const setup = await sessionSetup(task)
  const key = await keyOf(task, setup)
  const options = await optionsOf(task, abortController, setup)
  return { key: (await keyOf(task, setup)) === key ? key : null, options }
}
