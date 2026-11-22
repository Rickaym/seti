import type {
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  Options,
  PermissionMode,
  SdkPluginConfig,
} from '@anthropic-ai/claude-agent-sdk'
import type { Task } from '@seti/shared'
import { audit } from '../../audit.js'
import { compactHook, compactSetup } from '../../compact.js'
import { connectionEnv, taskConnections } from '../../connection-egress.js'
import { COMMAND_LIMIT_HOURS, subagentRules } from '../../house-rules.js'
import { taskBorrowedServers } from '../../mcp-borrowed.js'
import { planScope } from '../../memory-cap.js'
import { bashGuard, guardRefuses } from '../../permission-guard.js'
import { canUseToolFor } from '../../permission-requests.js'
import { repeatHooks } from '../../repeat-hooks.js'
import { reviewHook } from '../../review-hooks.js'
import { sandboxHooks } from '../../sandbox.js'
import { redactSecrets } from '../../scrub.js'
import {
  agentEnv,
  guardScope,
  inProcessServers,
  permissionSettings,
  sandboxFor,
  spawnInSandbox,
  spawnInScope,
  TASK_ID_ENV,
} from '../../session-options.js'
import type { SessionSpec } from '../../session-spec.js'
import { sharedToolServer } from '../../shared-tools.js'
import { allowedFor } from '../../store/change-requests.js'
import { workspaceDir, WORKSPACE_ENV } from '../../workspace/dir.js'

/** What a spec carries for Claude Code alone. */
export interface ClaudeVendor {
  plugins: SdkPluginConfig[]
}

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

/**
 * Claude Code switches a process into bypass only when it started with this flag, so a process
 * gets it only while Bypass is on; one that started without it takes Bypass at its next restart.
 */
const bypassLaunch = (mode: PermissionMode) =>
  mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}

/**
 * Everything a Claude Code process starts with that needs a new process when it changes. The mode
 * is left out: Seti switches a running process's mode without a restart.
 */
export const claudeSetup = (spec: SessionSpec) =>
  ({
    cwd: spec.cwd,
    ...(spec.dirs.length === 0 ? {} : { additionalDirectories: spec.dirs }),
    ...bypassLaunch(spec.mode),
    plugins: spec.vendor.plugins,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.instructions.append },
  }) satisfies Options

/** Claude Code leaves out the MCP servers a task turned off, whatever config names them. */
const deniedMcpSettings = (names: readonly string[]) => ({
  deniedMcpServers: names.map((serverName) => ({ serverName })),
})

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

/** Hooks of every task: the guards, a sandboxed one's WebFetch allowlist, rules for subagents. */
function sessionHooks(
  task: Task,
  sandboxed: boolean,
  session: AbortSignal,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const scope = guardScope(task, sandboxed)
  const guard = bashGuard(scope, auditRefusal(task))
  const sandbox = sandboxed ? (sandboxHooks(async () => allowedFor(task.id)).PreToolUse ?? []) : []
  const repeat = repeatHooks({ task, session, refused: (tool, input) => guardRefuses(tool, input, scope) })
  const review = reviewHook({ taskId: task.id, session, denyRules: async () => (await permissionSettings(task)).deny })
  const PreToolUse = [guard, ...sandbox, review, ...(repeat.PreToolUse ?? [])]
  return { ...repeat, PreToolUse, SubagentStart: [subagentRules()] }
}

/** Rules for every task, a sandbox's launcher and env, else the borrowed MCP servers. */
async function sandboxOptions(spec: SessionSpec, task: Task, session: AbortSignal) {
  const settings = { ...deniedMcpSettings(spec.deniedToolServers), permissions: spec.rules }
  const sandbox = await sandboxFor(task)
  const scope = await planScope(task.id, 'agent')
  if (sandbox === null) {
    const borrowed = (await taskBorrowedServers(task)) as Record<string, McpServerConfig>
    return {
      settings,
      hooks: sessionHooks(task, false, session),
      env: { ...agentEnv(scope?.cap ?? null), ...connectionEnv(await taskConnections(task)) },
      ...(Object.keys(borrowed).length === 0 ? {} : { mcpServers: borrowed }),
      ...(scope === null ? {} : { spawnClaudeCodeProcess: spawnInScope(scope) }),
    } satisfies Options
  }
  return {
    settings,
    hooks: sessionHooks(task, true, session),
    env: sandbox.env,
    spawnClaudeCodeProcess: spawnInSandbox(sandbox, task.id, scope),
  } satisfies Options
}

/** The borrowed servers of an unsandboxed task and the in-process ones, when there are any. */
function withInProcessServers(task: Task, servers: Record<string, McpServerConfig> = {}) {
  const all = { ...servers, ...inProcessServers(task) }
  return Object.keys(all).length === 0 ? {} : { mcpServers: all }
}

/** The SDK options a task's Claude Code process starts with, resuming the spec's session if any. */
export async function realise(spec: SessionSpec, task: Task, abortController: AbortController): Promise<Options> {
  const sandbox = await sandboxOptions(spec, task, abortController.signal)
  const compact = compactSetup(spec.compaction)
  return {
    ...claudeSetup(spec),
    permissionMode: spec.mode,
    ...(spec.resume === null ? {} : { resume: spec.resume }),
    enableFileCheckpointing: true,
    title: task.title,
    abortController,
    canUseTool: canUseToolFor(task.id, abortController.signal),
    perTaskStopAffordance: true,
    settingSources: ['user', 'project', 'local'],
    ...sandbox,
    ...withInProcessServers(task, {
      ...('mcpServers' in sandbox ? sandbox.mcpServers : {}),
      ...sharedToolServer(spec.toolServers.shared),
    }),
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
