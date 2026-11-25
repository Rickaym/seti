import { effortLevel, type CompactRule, type Task } from '@seti/shared'
import { claudeRules } from './approval-ceiling.js'
import { permissionModeOf } from './bypass-mode.js'
import { hostLoginKey } from './claude-logins.js'
import { requireCodexProgram } from './codex-status.js'
import { effectiveCompact } from './compact.js'
import { dreamsOn } from './dreams/settings.js'
import { launchPlan } from './launch-plan.js'
import { borrowedStamp, taskBorrowedServers } from './mcp-borrowed.js'
import { taskDeniedServers } from './mcp-selection.js'
import { tokenServers } from './mcp-sign-in.js'
import type { PermissionSettings } from './permission-policy.js'
import { taskPluginConfigs } from './plugins.js'
import type { RuntimeId } from './runtimes/adapter.js'
import type { CodexShapes } from './runtimes/codex/session.js'
import type { DefaultShapes } from './runtimes/registry.js'
import { signedInServers } from './sandbox-mcp.js'
import { sandboxStamp } from './sandbox-stamp.js'
import { systemAppend, workingDirs } from './session-options.js'
import { isClaudeSpec, isCodexSpec, realiseClaude } from './session-realise.js'
import { sharedToolFolders } from './shared-tools.js'
import { codexSettings } from './store/codex-settings.js'
import { userSkills } from './user-skills.js'

/** What a task's session starts from, read from the database; it holds no secret values. */
export interface SessionSpec<Id extends string = RuntimeId> {
  runtime: Id
  taskId: string
  title: string
  /** The runtime's session to resume, or null for a new one. */
  resume: string | null
  cwd: string
  /** The folders besides cwd the agent works in. */
  dirs: string[]
  /** Claude Code's permission mode; a runtime without modes runs as `default`. */
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
  /** Seti's nightly dreams tidy this agent's memory, so the runtime's own consolidation stays off. */
  setiDreams: boolean
  sandbox: Awaited<ReturnType<typeof sandboxStamp>>
  /** The login the host's runtime process signs in with. */
  account: string | null
  /** What only the runtime's own adapter reads. */
  vendor: Id extends 'codex' ? CodexShapes['vendor'] : DefaultShapes['vendor']
}

const sorted = (names: Set<string>) => [...names].toSorted((a, b) => a.localeCompare(b, 'en'))

/** The parts of a spec a process can change under while it starts, read again for its key. */
async function liveSpec(task: Task) {
  return {
    rules: await claudeRules(task),
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

/**
 * What a Codex agent's process starts: Seti's copy of the pinned Codex or the program the user
 * named, and the agent's model and effort, else the runtime's defaults. A runtime that is off,
 * installing or failed starts nothing.
 */
async function codexVendor(task: Task): Promise<CodexShapes['vendor']> {
  const settings = await codexSettings.get()
  return {
    binary: await requireCodexProgram(settings),
    model: task.requested_model ?? settings.default_model,
    effort: task.requested_effort ?? settings.default_effort,
    skills: userSkills(),
  }
}

/** A Claude Code agent's plugins, and the model and effort it was started with, if any. */
async function claudeVendor(task: Task): Promise<DefaultShapes['vendor']> {
  const effort = effortLevel(task.requested_effort)
  return {
    plugins: await taskPluginConfigs(task.id),
    ...(task.requested_model === null ? {} : { model: task.requested_model }),
    ...(effort === null ? {} : { effort }),
  }
}

const vendorOf = async (task: Task): Promise<SessionSpec['vendor']> =>
  task.runtime === 'codex' ? codexVendor(task) : claudeVendor(task)

/** The task's session spec, resuming its session if it has one. */
async function sessionSpec(task: Task): Promise<SessionSpec> {
  return {
    runtime: task.runtime,
    taskId: task.id,
    title: task.title,
    resume: task.session_id,
    cwd: task.cwd,
    dirs: workingDirs(task),
    mode: task.runtime === 'codex' ? 'default' : await permissionModeOf(task),
    instructions: { append: await systemAppend(task.id) },
    setiControl: task.seti_control,
    setiDreams: await dreamsOn(task),
    vendor: await vendorOf(task),
    ...(await liveSpec(task)),
  }
}

/**
 * What a process of the spec starts with that needs a new process when it changes. The mode is
 * left out except for bypass, which only a start can turn on; a running process switches modes.
 */
const setupOf = <Id extends RuntimeId>(spec: SessionSpec<Id>) => ({
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

/** A digest of a Codex agent's setup: what Codex starts with, by the runtime's own names. */
function codexKey(spec: SessionSpec<'codex'>): string {
  const setup = setupOf(spec)
  return JSON.stringify({
    runtime: 'codex',
    cwd: setup.cwd,
    dirs: setup.dirs,
    codex: setup.vendor,
    instructions: setup.instructions,
    shared_tools: setup.toolServers.shared,
    seti_control: setup.setiControl,
    sandbox: setup.sandbox,
  })
}

/**
 * A digest of the spec's setup. A Claude Code agent's has the layout keys had before runtimes
 * existed, so a process started by an earlier release keeps its key, and its session, across a
 * deploy; only an agent started on a picked model or effort has them in its key.
 */
function specKey(spec: SessionSpec): string {
  if (isCodexSpec(spec)) {
    return codexKey(spec)
  }
  if (!isClaudeSpec(spec)) {
    throw new Error('Seti has no such runtime')
  }
  const setup = setupOf(spec)
  return JSON.stringify({
    cwd: setup.cwd,
    ...(setup.dirs.length === 0 ? {} : { additionalDirectories: setup.dirs }),
    ...(setup.bypass ? { allowDangerouslySkipPermissions: true } : {}),
    plugins: setup.vendor.plugins,
    ...(setup.vendor.model === undefined ? {} : { model: setup.vendor.model }),
    ...(setup.vendor.effort === undefined ? {} : { effort: setup.vendor.effort }),
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
export async function sessionOptions(task: Task, abortController: AbortController) {
  const spec = await sessionSpec(task)
  if (!isClaudeSpec(spec)) {
    throw new Error('Only a Claude Code agent starts with these options')
  }
  return realiseClaude(spec, task, await launchPlan(task), abortController)
}

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
