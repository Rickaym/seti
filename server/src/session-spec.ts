import type { CompactRule, Task } from '@seti/shared'
import { permissionModeOf } from './bypass-mode.js'
import { hostLoginKey } from './claude-logins.js'
import { compactSetup, effectiveCompact } from './compact.js'
import { taskLauncher } from './launcher.js'
import { borrowedStamp, taskBorrowedServers } from './mcp-borrowed.js'
import { taskDeniedServers } from './mcp-selection.js'
import { tokenServers } from './mcp-sign-in.js'
import type { PermissionSettings } from './permission-policy.js'
import { taskPluginConfigs } from './plugins.js'
import { sessionHost } from './runtime-host.js'
import type { RuntimeId } from './runtimes/adapter.js'
import { claudeSetup } from './runtimes/claude/realise.js'
import { adapterFor, DEFAULT_RUNTIME, type DefaultShapes } from './runtimes/registry.js'
import { signedInServers } from './sandbox-mcp.js'
import { permissionSettings, sandboxStamp, systemAppend, workingDirs } from './session-options.js'
import { sharedToolFolders } from './shared-tools.js'

/** What a task's session starts from, read from the database; it holds no secret values. */
export interface SessionSpec {
  runtime: RuntimeId
  taskId: string
  title: string
  /** The runtime's session to resume, or null for a new one. */
  resume: string | null
  cwd: string
  /** The folders besides cwd the agent works in. */
  dirs: string[]
  mode: DefaultShapes['mode']
  instructions: { append: string }
  rules: PermissionSettings
  deniedToolServers: string[]
  /** The shared tool folders, and stamps of the borrowed and signed-in servers without values. */
  toolServers: {
    shared: string[]
    borrowed: ReturnType<typeof borrowedStamp>
    signedIn: string[]
    tokens: string[]
  }
  setiControl: Task['seti_control']
  compaction: CompactRule
  sandbox: Awaited<ReturnType<typeof sandboxStamp>>
  /** The login the host's runtime process signs in with. */
  account: string | null
  /** What only the runtime's own adapter reads. */
  vendor: DefaultShapes['vendor']
}

const sorted = (names: Set<string>) => [...names].toSorted((a, b) => a.localeCompare(b, 'en'))

/** The parts of a spec a process can change under while it starts, read again for its key. */
async function liveSpec(task: Task) {
  return {
    rules: await permissionSettings(task),
    deniedToolServers: await taskDeniedServers(task.id),
    toolServers: {
      shared: await sharedToolFolders(task),
      borrowed: borrowedStamp(await taskBorrowedServers(task)),
      signedIn: sorted(signedInServers()),
      tokens: sorted(tokenServers()),
    },
    compaction: await effectiveCompact(task.id),
    account: hostLoginKey(),
    sandbox: await sandboxStamp(task),
  }
}

/** The task's session spec, resuming its session if it has one. */
async function sessionSpec(task: Task): Promise<SessionSpec> {
  return {
    runtime: DEFAULT_RUNTIME,
    taskId: task.id,
    title: task.title,
    resume: task.session_id,
    cwd: task.cwd,
    dirs: workingDirs(task),
    mode: permissionModeOf(task),
    instructions: { append: await systemAppend(task.id) },
    setiControl: task.seti_control,
    vendor: { plugins: await taskPluginConfigs(task.id) },
    ...(await liveSpec(task)),
  }
}

/** A digest of the spec, in the shape the setup key had before there was a spec. */
function specKey(spec: SessionSpec): string {
  return JSON.stringify({
    ...claudeSetup(spec),
    mcp_denied: spec.deniedToolServers,
    shared_tools: spec.toolServers.shared,
    mcp_borrowed: spec.toolServers.borrowed,
    mcp_signed_in: spec.toolServers.signedIn,
    mcp_tokens: spec.toolServers.tokens,
    seti_control: spec.setiControl,
    compact: compactSetup(spec.compaction),
    claude_login: spec.account,
    sandbox: spec.sandbox,
  })
}

/** Compares the setup a process started with to what the task needs now. */
export const setupKey = async (task: Task) => specKey(await sessionSpec(task))

async function realise(spec: SessionSpec, task: Task, abortController: AbortController) {
  const launcher = await taskLauncher(task, 'agent', true)
  const host = sessionHost(task, launcher.sandboxed, abortController.signal)
  return adapterFor(spec.runtime).realise(spec, launcher, host, abortController)
}

/** The options a task's process starts with, resuming the task's session if any. */
export const sessionOptions = async (task: Task, abortController: AbortController) =>
  realise(await sessionSpec(task), task, abortController)

const reread = async (spec: SessionSpec, task: Task): Promise<SessionSpec> => ({ ...spec, ...(await liveSpec(task)) })

/**
 * The options a process starts with and the setupKey of what it got. The options take the live
 * parts as read after the key, and a setting that changed meanwhile leaves no key, so the next
 * turn restarts.
 */
export async function sessionStart(task: Task, abortController: AbortController) {
  const spec = await sessionSpec(task)
  const key = specKey(spec)
  const options = await realise(await reread(spec, task), task, abortController)
  return { key: specKey(await reread(spec, task)) === key ? key : null, options }
}
