import path from 'node:path'
import type { CpuCap, MemoryCap, ProxyGrant, SandboxPolicy, Task } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { profileAws, taskAws } from './aws-access.js'
import { connectorCredential } from './claude-credential.js'
import { codexKeyConnection } from './codex-key.js'
import { codexProgram } from './codex-status.js'
import { effectiveCpuCap } from './cpu-cap.js'
import { agentTokenStamp } from './github-token.js'
import { launcherFrom, sandboxFrom } from './launcher.js'
import { taskBorrowedServers } from './mcp-borrowed.js'
import { effectiveCap } from './memory-cap.js'
import type { ScopeKind } from './memory-scope.js'
import { taskPluginConfigs } from './plugins.js'
import { proxyGrant } from './proxy-grant.js'
import type { RuntimeId } from './runtimes/adapter.js'
import { sharedToolFolders, TOOL_SERVER } from './shared-tools.js'
import { knownHostsText, publicKeys } from './ssh-files.js'
import { sandboxPolicy } from './store/sandbox.js'
import type { SshHostRow } from './store/ssh.js'

/** The ssh a sandbox renders: the hosts on the way, their known host keys and public keys. */
export interface SshPlan {
  hosts: SshHostRow[]
  knownHosts: string
  /** Public keys by key id; the private halves reach the node's ssh agent by ask. */
  publicKeys: Record<string, string>
}

/** What a sandbox around the agent's process is made of, with no value in it. */
export interface SandboxPlan {
  policy: SandboxPolicy
  /** Plugin or runtime program, tool server and shared tool folders the sandbox mounts read-only. */
  readOnly: string[]
  grant: ProxyGrant
  /** The MCP servers the agent turned off. */
  denied: string[]
  /** The borrowed MCP servers the agent may use, by name; their settings stay in the host file. */
  borrowed: string[]
  ssh: SshPlan | null
  github: boolean
  connectors: boolean
  aws: { region: string } | null
  /**
   * Present for a Codex agent, whose sandbox holds no Claude configuration: the variable of the
   * connection that carries its OpenAI key, or null when it has none.
   */
  codex?: { modelKey: string | null }
}

/**
 * Everything a process of the agent starts from besides the runtime's spec: its caps, and its
 * sandbox when it runs in one. The control plane reads it; the node only applies it.
 */
export interface LaunchPlan {
  memory: MemoryCap
  cpu: CpuCap
  sandbox: SandboxPlan | null
  /** Connection variables an unsandboxed process holds, set to their placeholders. */
  grant: ProxyGrant
}

async function sshPlan(taskId: string): Promise<SshPlan | null> {
  const reach = await taskSsh(taskId)
  if (reach.usable.length === 0) {
    return null
  }
  return {
    hosts: reach.hosts,
    knownHosts: await knownHostsText(reach.knownHosts),
    publicKeys: await publicKeys(reach.hosts),
  }
}

/** The folder of the program a Codex agent runs, which its sandbox mounts read-only. */
async function codexFolders(): Promise<string[]> {
  const program = await codexProgram()
  return program === null ? [] : [path.dirname(program)]
}

/** A Codex agent's part of its plan, which leaves out Claude's plugins, servers and connectors. */
async function codexPart(task: Task) {
  return { codex: { modelKey: (await codexKeyConnection(task))?.env ?? null }, connectors: false, borrowed: [] }
}

/** What the agent's sandbox is made of under this policy. */
export async function sandboxPlanFor(
  task: Task,
  policy: SandboxPolicy,
  runtime: RuntimeId = task.runtime,
): Promise<SandboxPlan> {
  const { grant, denied } = await proxyGrant(task, runtime)
  const own =
    runtime === 'codex' ? await codexFolders() : (await taskPluginConfigs(task.id)).map((plugin) => plugin.path)
  const tools = await sharedToolFolders(task)
  return {
    policy,
    readOnly: tools.length === 0 ? own : [...own, TOOL_SERVER, ...tools],
    grant,
    denied: [...denied],
    borrowed: Object.keys(await taskBorrowedServers(task)),
    ssh: await sshPlan(task.id),
    github: (await agentTokenStamp(task.profile_id)) !== null,
    connectors: connectorCredential() !== null,
    aws: (await taskAws(task.id)) ? { region: (await profileAws(task.profile_id)).region } : null,
    ...(runtime === 'codex' ? await codexPart(task) : {}),
  }
}

/** The agent's launch plan, read from the store and the host's settings. */
export async function launchPlan(task: Task, runtime: RuntimeId = task.runtime): Promise<LaunchPlan> {
  const policy = await sandboxPolicy.get()
  const sandbox = policy.enabled && task.sandbox ? await sandboxPlanFor(task, policy, runtime) : null
  return {
    memory: await effectiveCap(task.id),
    cpu: await effectiveCpuCap(task.id),
    sandbox,
    grant: sandbox?.grant ?? (await proxyGrant(task, runtime)).grant,
  }
}

/** The task's sandbox, from a plan read now; null when it runs unsandboxed. */
export const sandboxFor = async (task: Task) => sandboxFrom(task, await launchPlan(task))

/** Where a task's process starts, from a plan read now. */
export const taskLauncher = async (task: Task, kind: ScopeKind, connections: boolean) =>
  launcherFrom(task, kind, connections, await launchPlan(task))
