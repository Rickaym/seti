import path from 'node:path'
import type { McpServerConfig, Options, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk'
import { extraDirs, type CpuCap, type MemoryCap, type SandboxPolicy, type Task } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { taskAws } from './aws-access.js'
import { bypassLaunch, permissionModeOf } from './bypass-mode.js'
import { hostLoginKey } from './claude-logins.js'
import { compactSetup, effectiveCompact } from './compact.js'
import { connectionEnv, taskConnections } from './connection-egress.js'
import { effectiveCpuCap } from './cpu-cap.js'
import { borrowedStamp, taskBorrowedServers } from './mcp-borrowed.js'
import { taskDeniedServers } from './mcp-selection.js'
import { tokenServers } from './mcp-sign-in.js'
import { effectiveCap } from './memory-cap.js'
import { builtInRules, composeRules, type PermissionSettings } from './permission-policy.js'
import { taskPluginConfigs } from './plugins.js'
import { GUARDED_HOME, sandboxContext } from './sandbox-context.js'
import { mcpTargets, signedInServers } from './sandbox-mcp.js'
import { secretDenyRules, unsandboxedHookRules } from './sandbox.js'
import { sharedToolFolders, sharedToolServer, TOOL_SERVER } from './shared-tools.js'
import { keyStamp, sshStamp } from './ssh-files.js'
import { profiles } from './store/credentials.js'
import { permissionRules } from './store/permissions.js'
import { sandboxPolicy } from './store/sandbox.js'
import { profileStamp } from './task-credentials.js'
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

export async function systemAppend(taskId: string): Promise<string> {
  const extra = await Promise.all(contextProviders.map(async (provider) => provider(taskId)))
  return extra.filter((text) => text !== null).join('\n\n')
}

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

type SessionSetup = Awaited<ReturnType<typeof sessionSetup>>

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

/** The mode is left out: Seti switches a running process's mode without a restart. */
const keyOf = async (task: Task, { permissionMode: _mode, ...setup }: SessionSetup) =>
  JSON.stringify({
    ...setup,
    mcp_denied: await taskDeniedServers(task.id),
    shared_tools: await sharedToolFolders(task),
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

/** The sandbox a task runs in, with its plugins and shared tools read-only; null without one. */
export interface SandboxSpec {
  policy: SandboxPolicy
  readOnly: string[]
}

export async function sandboxSpec(task: Task): Promise<SandboxSpec | null> {
  const policy = await sandboxPolicy.get()
  if (!(policy.enabled && task.sandbox)) {
    return null
  }
  const plugins = (await taskPluginConfigs(task.id)).map((plugin) => plugin.path)
  const tools = await sharedToolFolders(task)
  return { policy, readOnly: tools.length === 0 ? plugins : [...plugins, TOOL_SERVER, ...tools] }
}

/** The caps a task's process tree runs under, where the host can hold it to them. */
export const taskCaps = async (taskId: string) => ({
  memory: await effectiveCap(taskId),
  cpu: await effectiveCpuCap(taskId),
})

/**
 * Everything a session's process needs from Seti's records, as plain data: the node turns it into
 * SDK options with its own sandbox, scope and callbacks.
 */
export interface SessionSpec {
  task: Task
  setup: SessionSetup & { plugins: SdkPluginConfig[] }
  settings: { deniedMcpServers: { serverName: string }[]; permissions: PermissionSettings }
  compact: ReturnType<typeof compactSetup>
  sandbox: SandboxSpec | null
  caps: { memory: MemoryCap; cpu: CpuCap }
  /** Connection variables of an unsandboxed task; a sandbox sets its own placeholders. */
  connectionEnv: Record<string, string>
  /** Borrowed servers of an unsandboxed task and the shared tool server, all run as commands. */
  mcpServers: Record<string, McpServerConfig>
}

async function specOf(task: Task, setup: SessionSetup): Promise<SessionSpec> {
  const sandbox = await sandboxSpec(task)
  const borrowed = sandbox === null ? ((await taskBorrowedServers(task)) as Record<string, McpServerConfig>) : {}
  return {
    task,
    setup,
    settings: {
      deniedMcpServers: (await taskDeniedServers(task.id)).map((serverName) => ({ serverName })),
      permissions: await permissionSettings(task),
    },
    compact: compactSetup(await effectiveCompact(task.id)),
    sandbox,
    caps: await taskCaps(task.id),
    connectionEnv: sandbox === null ? connectionEnv(await taskConnections(task)) : {},
    mcpServers: { ...borrowed, ...sharedToolServer(await sharedToolFolders(task)) },
  }
}

/**
 * The spec a process starts with and the setupKey of what it got, from one read of the setup.
 * A setting that changed while the spec was read leaves no key, so the next turn restarts.
 */
export async function sessionSpec(task: Task): Promise<{ key: string | null; spec: SessionSpec }> {
  const setup = await sessionSetup(task)
  const key = await keyOf(task, setup)
  const spec = await specOf(task, setup)
  return { key: (await keyOf(task, setup)) === key ? key : null, spec }
}
