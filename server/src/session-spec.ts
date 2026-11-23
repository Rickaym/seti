import type { CompactRule, Task } from '@seti/shared'
import { permissionModeOf } from './bypass-mode.js'
import { hostLoginKey } from './claude-logins.js'
import { effectiveCompact } from './compact.js'
import { launchPlan } from './launch-plan.js'
import { borrowedStamp, taskBorrowedServers } from './mcp-borrowed.js'
import { taskDeniedServers } from './mcp-selection.js'
import { tokenServers } from './mcp-sign-in.js'
import type { PermissionSettings } from './permission-policy.js'
import { taskPluginConfigs } from './plugins.js'
import type { RuntimeId } from './runtimes/adapter.js'
import { DEFAULT_RUNTIME, type DefaultShapes } from './runtimes/registry.js'
import { signedInServers } from './sandbox-mcp.js'
import { permissionSettings, sandboxStamp, systemAppend, workingDirs } from './session-options.js'
import { realise } from './session-realise.js'
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

/**
 * What a process of the spec starts with that needs a new process when it changes. The mode is
 * left out except for bypass, which only a start can turn on; a running process switches modes.
 */
const setupOf = (spec: SessionSpec) => ({
  cwd: spec.cwd,
  dirs: spec.dirs,
  bypass: spec.mode === 'bypassPermissions',
  vendor: spec.vendor,
  instructions: spec.instructions.append,
  deniedToolServers: spec.deniedToolServers,
  toolServers: spec.toolServers,
  setiControl: spec.setiControl,
  compaction: spec.compaction,
  account: spec.account,
  sandbox: spec.sandbox,
})

/** The compaction rule in the form keys have always held it. */
const compactionKey = (rule: CompactRule) => ({
  settings: {
    autoCompactEnabled: rule.auto,
    ...(rule.window_k === null ? {} : { autoCompactWindow: rule.window_k * 1000 }),
  },
  env: rule.threshold_pct === null ? {} : { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(rule.threshold_pct) },
})

/**
 * A digest of the spec's setup. Its layout is the one keys had before runtimes existed, so a
 * process started by an earlier release keeps its key, and its session, across a deploy.
 */
function specKey(spec: SessionSpec): string {
  const setup = setupOf(spec)
  return JSON.stringify({
    cwd: setup.cwd,
    ...(setup.dirs.length === 0 ? {} : { additionalDirectories: setup.dirs }),
    ...(setup.bypass ? { allowDangerouslySkipPermissions: true } : {}),
    plugins: setup.vendor.plugins,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: setup.instructions },
    mcp_denied: setup.deniedToolServers,
    shared_tools: setup.toolServers.shared,
    mcp_borrowed: setup.toolServers.borrowed,
    mcp_signed_in: setup.toolServers.signedIn,
    mcp_tokens: setup.toolServers.tokens,
    seti_control: setup.setiControl,
    compact: compactionKey(setup.compaction),
    claude_login: setup.account,
    sandbox: setup.sandbox,
  })
}

/** Compares the setup a process started with to what the task needs now. */
export const setupKey = async (task: Task) => specKey(await sessionSpec(task))

/** The options a task's process starts with, resuming the task's session if any. */
export const sessionOptions = async (task: Task, abortController: AbortController) =>
  realise(await sessionSpec(task), task, await launchPlan(task), abortController)

const reread = async (spec: SessionSpec, task: Task): Promise<SessionSpec> => ({ ...spec, ...(await liveSpec(task)) })

/**
 * The spec a process starts from and the setupKey of the settings first read. The spec takes the
 * live parts as read after the key; the node compares the key again once the process started.
 */
export async function startingSpec(task: Task): Promise<{ spec: SessionSpec; key: string }> {
  const spec = await sessionSpec(task)
  return { spec: await reread(spec, task), key: specKey(spec) }
}

/** The setupKey of a spec a process started from, with its live parts read again. */
export const rereadKey = async (spec: SessionSpec, task: Task): Promise<string> => specKey(await reread(spec, task))
