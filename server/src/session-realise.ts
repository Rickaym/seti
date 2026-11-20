import { spawn, type ChildProcess } from 'node:child_process'
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
import { extraDirs, type MemoryCap, type Task } from '@seti/shared'
import { COMMAND_LIMIT_HOURS, subagentRules } from './house-rules.js'
import { launch, scopeHost, type ScopePlan } from './memory-scope.js'
import { memoryEnv } from './node-heap.js'
import { bashGuard, type GuardScope } from './permission-guard.js'
import type { SandboxAccess } from './sandbox-access.js'
import { GUARDED_HOME, sandboxContext } from './sandbox-context.js'
import { setiHomePaths } from './sandbox.js'
import type { SessionDecisions } from './session-decisions.js'
import type { SandboxSpec, SessionSpec } from './session-spec.js'
import { taskSandbox, type TaskSandbox } from './task-sandbox.js'
import { hostToolShell, toolShellEnv } from './tool-shell.js'
import { workspaceDir, WORKSPACE_ENV } from './workspace/dir.js'

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

/** Names the task in its process's environment, so the resource sampler can tell processes apart. */
export const TASK_ID_ENV = 'SETI_TASK_ID'

/**
 * Claude Code stops a background command at its `timeout`, 30 minutes unless the agent sets one,
 * and caps that at 2 hours; this raises the cap to a day.
 */
const BACKGROUND_LIMIT = { BASH_MAX_TIMEOUT_MS: String(COMMAND_LIMIT_HOURS * 60 * 60_000) }

/**
 * Claude Code leaves its own todo tools (TaskCreate and the rest, TodoWrite before them) out for
 * newer models unless this is set; the agent's todo list in Seti is read from those calls.
 */
const TODO_TOOLS = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }

/** Claude Code runs Bash commands in the login shell, often zsh; agents write bash, so use bash. */
const BASH_SHELL = { CLAUDE_CODE_SHELL: '/bin/bash', SHELL: '/bin/bash' }

/** How the task's process tree is held to its caps on this host; null where it cannot be. */
export async function scopeOf(taskId: string, caps: SessionSpec['caps']): Promise<ScopePlan | null> {
  const host = await scopeHost()
  return host === null ? null : { host, taskId, kind: 'agent', cap: caps.memory, cpu: caps.cpu }
}

/** Prepares the task's sandbox from its spec, or null when it runs without one. */
export async function sandboxOf(task: Task, spec: SandboxSpec | null, memory: MemoryCap | null, access: SandboxAccess) {
  return spec === null
    ? null
    : taskSandbox(task, { ctx: sandboxContext(), policy: spec.policy, readOnly: spec.readOnly, memory, access })
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

/** Hooks of every task: the guards, a sandboxed one's WebFetch allowlist, rules for subagents. */
function sessionHooks(
  task: Task,
  sandboxed: boolean,
  session: AbortSignal,
  decisions: SessionDecisions,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const scope = guardScope(task, sandboxed)
  const guard = bashGuard(scope, decisions.guardRefused(task))
  const decided = decisions.hooks(task, scope, session)
  return { ...decided, PreToolUse: [guard, ...(decided.PreToolUse ?? [])], SubagentStart: [subagentRules()] }
}

/** A sandbox's launcher and env, else the host's env and scope, with the hooks of either. */
async function placement(spec: SessionSpec, session: AbortSignal, decisions: SessionDecisions) {
  const { task } = spec
  const scope = await scopeOf(task.id, spec.caps)
  const sandbox = await sandboxOf(task, spec.sandbox, scope?.cap ?? null, decisions.sandbox)
  const hooks = sessionHooks(task, sandbox !== null, session, decisions)
  if (sandbox === null) {
    return {
      hooks,
      env: { ...agentEnv(scope?.cap ?? null), ...spec.connectionEnv },
      ...(scope === null ? {} : { spawnClaudeCodeProcess: spawnInScope(scope) }),
    } satisfies Options
  }
  return { hooks, env: sandbox.env, spawnClaudeCodeProcess: spawnInSandbox(sandbox, task.id, scope) } satisfies Options
}

/** The spec's command servers and the ones that answer inside Seti, when there are any. */
function servers(spec: SessionSpec, decisions: SessionDecisions) {
  const all: Record<string, McpServerConfig> = { ...spec.mcpServers, ...decisions.servers(spec.task) }
  return Object.keys(all).length === 0 ? {} : { mcpServers: all }
}

/** Turns a spec into the options its Claude Code process starts with, resuming its session if any. */
export async function realiseSpec(
  spec: SessionSpec,
  abortController: AbortController,
  decisions: SessionDecisions,
): Promise<Options> {
  const { task } = spec
  const placed = await placement(spec, abortController.signal, decisions)
  return {
    ...spec.setup,
    ...(task.session_id === null ? {} : { resume: task.session_id }),
    enableFileCheckpointing: true,
    title: task.title,
    abortController,
    canUseTool: decisions.canUseTool(task.id, abortController.signal),
    perTaskStopAffordance: true,
    settingSources: ['user', 'project', 'local'],
    ...placed,
    ...servers(spec, decisions),
    settings: { ...spec.settings, ...spec.compact.settings },
    hooks: { ...placed.hooks, PreCompact: [decisions.compact(task.id)] },
    env: {
      ...BACKGROUND_LIMIT,
      ...TODO_TOOLS,
      ...placed.env,
      ...BASH_SHELL,
      ...spec.compact.env,
      [TASK_ID_ENV]: task.id,
      [WORKSPACE_ENV]: workspaceDir(task.id),
    },
  }
}
