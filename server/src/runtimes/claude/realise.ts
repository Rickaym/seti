import type { McpServerConfig, Options, PermissionMode, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk'
import type { CompactRule } from '@seti/shared'
import { COMMAND_LIMIT_HOURS } from '../../house-rules.js'
import type { Launcher } from '../../launcher.js'
import { taskBorrowedServers } from '../../mcp-borrowed.js'
import type { SessionSpec } from '../../session-spec.js'
import { sharedToolServer } from '../../shared-tools.js'
import { workspaceDir, WORKSPACE_ENV } from '../../workspace/dir.js'
import type { SessionHost } from '../adapter.js'
import type { ClaudeShapes } from './session.js'

/** What Seti answers for a Claude Code session. */
type ClaudeHost = SessionHost<ClaudeShapes>

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

/** What a compaction rule starts a Claude Code process with; a change takes a new process. */
export const compactSetup = (rule: CompactRule) => ({
  settings: {
    autoCompactEnabled: rule.auto,
    ...(rule.window_k === null ? {} : { autoCompactWindow: rule.window_k * 1000 }),
  },
  env: rule.threshold_pct === null ? {} : { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(rule.threshold_pct) },
})

/**
 * Everything a Claude Code process starts with that needs a new process when it changes. The mode
 * is left out: Seti switches a running process's mode without a restart.
 */
const claudeSetup = (spec: SessionSpec) =>
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

/**
 * The launcher as the SDK takes it: the environment, and the spawn when Seti holds the process.
 * Without a spawn the SDK starts Claude Code on the host, which no sandboxed launcher allows.
 */
export function claudeLaunch(launcher: Launcher) {
  if (launcher.spawn === undefined && launcher.sandboxed) {
    throw new Error('A sandboxed launcher must start Claude Code itself, and this one cannot')
  }
  return { env: launcher.env, ...(launcher.spawn === undefined ? {} : { spawnClaudeCodeProcess: launcher.spawn }) }
}

/** Rules for every task, the launcher, and an unsandboxed task's borrowed MCP servers. */
async function sandboxOptions(spec: SessionSpec, launcher: Launcher) {
  const settings = { ...deniedMcpSettings(spec.deniedToolServers), permissions: spec.rules }
  const borrowed = launcher.sandboxed
    ? {}
    : ((await taskBorrowedServers({ id: spec.taskId, cwd: spec.cwd })) as Record<string, McpServerConfig>)
  return {
    settings,
    ...claudeLaunch(launcher),
    ...(Object.keys(borrowed).length === 0 ? {} : { mcpServers: borrowed }),
  } satisfies Options
}

/** The borrowed servers of an unsandboxed task and the host's own, when there are any. */
function withHostServers(host: ClaudeHost, servers: Record<string, McpServerConfig>) {
  const all = { ...servers, ...host.toolServers }
  return Object.keys(all).length === 0 ? {} : { mcpServers: all }
}

/** The SDK options a task's Claude Code process starts with, resuming the spec's session if any. */
export async function realise(
  spec: SessionSpec,
  launcher: Launcher,
  host: ClaudeHost,
  abortController: AbortController,
): Promise<Options> {
  const sandbox = await sandboxOptions(spec, launcher)
  const compact = compactSetup(spec.compaction)
  return {
    ...claudeSetup(spec),
    permissionMode: spec.mode,
    ...(spec.resume === null ? {} : { resume: spec.resume }),
    enableFileCheckpointing: true,
    title: spec.title,
    abortController,
    canUseTool: host.decide,
    perTaskStopAffordance: true,
    settingSources: ['user', 'project', 'local'],
    ...sandbox,
    ...withHostServers(host, {
      ...('mcpServers' in sandbox ? sandbox.mcpServers : {}),
      ...sharedToolServer(spec.toolServers.shared),
    }),
    settings: { ...sandbox.settings, ...compact.settings, ...(spec.setiDreams ? { autoDreamEnabled: false } : {}) },
    hooks: host.hooks,
    env: {
      ...BACKGROUND_LIMIT,
      ...TODO_TOOLS,
      ...sandbox.env,
      ...BASH_SHELL,
      ...compact.env,
      [WORKSPACE_ENV]: workspaceDir(spec.taskId),
    },
  }
}
