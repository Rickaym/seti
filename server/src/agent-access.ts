import {
  AWS_ACCESS_ID,
  DEFAULT_PROFILE_ID,
  localServerNote,
  overrideFor,
  type AccessChoice,
  type AccessDefault,
  type AccessItem,
  type AccessKind,
  type AuditActor,
  type AuditKind,
  type McpSelectionKind,
  type McpSessionState,
  type Task,
  type TaskAccessInput,
  type TaskAccessView,
  type TaskMcpServer,
} from '@seti/shared'
import { audit } from './audit.js'
import { AWS_NAME, awsItem, sandboxed, taskAws, taskAwsOutcome, taskGitHubOutcome } from './aws-access.js'
import { setPackLinkedByDefault } from './context-changes.js'
import { tasks } from './db.js'
import { fromEa, refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { ownProjects, readHostConfig, taskBorrowedServers } from './mcp-borrowed.js'
import { mcpCatalog, mcpDefaultFor, setMcpDefault, taskMcpServers } from './mcp-selection.js'
import { sessionMcp, sessionState } from './mcp-session-status.js'
import { tokenServers } from './mcp-sign-in.js'
import { pluginLoaded, setDefaultPluginEnabled } from './plugins.js'
import { signedInServers } from './sandbox-mcp.js'
import { reloadSshAgents } from './ssh-agent.js'
import { hostMap, sshReach, sshRoute, type SshReach } from './ssh-config.js'
import { accessDefaults, taskAccess } from './store/access.js'
import { taskHosts } from './store/change-requests.js'
import { contextPacks, taskContextPacks } from './store/context.js'
import { profiles } from './store/credentials.js'
import { taskMcpChoices } from './store/mcp.js'
import { setiPlugins, taskPluginChoices } from './store/plugins.js'
import { setHosts, sshHostStore } from './store/ssh.js'
import { signalWorkspaces } from './workspace/dir.js'

const MCP_KIND: Record<McpSelectionKind, string> = { config: 'configured', plugin: 'plugin', connector: 'claude.ai' }

const KIND_LABEL: Record<AccessKind, string> = {
  ssh: 'ssh host',
  aws: 'AWS',
  mcp: 'MCP server',
  pack: 'context pack',
  plugin: 'plugin',
}

const AUDIT_KIND: Record<AccessKind, AuditKind> = {
  ssh: 'task.access_changed',
  aws: 'task.access_changed',
  plugin: 'task.access_changed',
  mcp: 'task.mcp_changed',
  pack: 'task.context_packs_changed',
}

type Choices = Readonly<Record<string, boolean>>

/** Hosts granted on their own, by choice or default, and those the agent's set bundles. */
async function sshGrants(profileId: string, overrides: Choices) {
  const [list, defaults, bundled] = await Promise.all([
    sshHostStore.list(),
    accessDefaults.all('ssh'),
    setHosts.forProfile(profileId),
  ])
  const enabled = list
    .map((host) => host.alias)
    .filter((alias) => bundled.includes(alias) || (overrides[alias] ?? defaults[alias] ?? false))
  return { list, defaults, bundled, reach: sshReach(list, enabled) }
}

const reachFor = async (profileId: string, overrides: Choices): Promise<SshReach> =>
  (await sshGrants(profileId, overrides)).reach

async function sshItems(overrides: Choices, profileId: string | null): Promise<AccessItem[]> {
  const { list, defaults, bundled, reach } = await sshGrants(profileId ?? '', overrides)
  const rows = hostMap(list)
  return list.map((host) => ({
    kind: 'ssh',
    id: host.alias,
    name: host.alias,
    detail: sshRoute(rows, host.alias),
    default_enabled: defaults[host.alias] ?? false,
    override: overrides[host.alias] ?? null,
    enabled: reach.enabled.includes(host.alias),
    jump_for: reach.jumpFor.get(host.alias) ?? [],
    missing_key: reach.missing.get(host.alias) ?? [],
    in_set: bundled.includes(host.alias),
    session: null,
  }))
}

type Json = Record<string, unknown>

const entryOf = (servers: unknown, name: string): unknown =>
  typeof servers === 'object' && servers !== null && name in servers ? (servers as Json)[name] : undefined

/** How each enabled server stands in the task's latest session; null before its first session. */
async function sessionStates(task: Task): Promise<(name: string) => McpSessionState | null> {
  const report = await sessionMcp(task.id)
  if (report === null) {
    return () => null
  }
  const host = readHostConfig()
  const projects = (host.projects ?? {}) as Json
  const borrowed = await taskBorrowedServers(task, host)
  const own = [host, ...ownProjects(task.cwd).map((key) => projects[key])].map((entry) =>
    typeof entry === 'object' && entry !== null && 'mcpServers' in entry ? entry.mcpServers : undefined,
  )
  const isSandboxed = await sandboxed(task)
  const signedIn = signedInServers()
  const stored = tokenServers()
  return (name) => {
    const config = [...own, borrowed].map((servers) => entryOf(servers, name)).find((entry) => entry !== undefined)
    const context = {
      config,
      sandboxed: isSandboxed,
      signedIn: signedIn.has(name),
      tokenStored: stored.has(name),
      inSetup: config !== undefined,
    }
    return sessionState(name, report, context)
  }
}

/** How the agent's latest session has an enabled server; null when off or before any session. */
export const taskMcpSession = async (task: Task, name: string): Promise<McpSessionState | null> =>
  (await mcpItems(task)).find((item) => item.id === name)?.session ?? null

function mcpDetail(server: TaskMcpServer): string {
  if (server.borrowed) {
    return localServerNote(server.local_to, server.default_enabled)
  }
  return server.kind === null ? 'not configured' : MCP_KIND[server.kind]
}

async function mcpItems(task: Task | null): Promise<AccessItem[]> {
  const servers: TaskMcpServer[] =
    task === null
      ? (await mcpCatalog()).map((entry) => ({
          ...entry,
          choice: null,
          enabled: entry.default_enabled,
          borrowed: entry.local_to.length > 0,
        }))
      : await taskMcpServers(task.id)
  const stateOf = task === null ? () => null : await sessionStates(task)
  return servers.map((server) => ({
    kind: 'mcp',
    id: server.name,
    name: server.name,
    detail: mcpDetail(server),
    default_enabled: server.default_enabled,
    override: server.choice,
    enabled: server.enabled,
    jump_for: [],
    missing_key: [],
    in_set: false,
    session: server.enabled ? stateOf(server.name) : null,
  }))
}

/** Reference packs only: an agent's role pack is picked in its settings, one at a time. */
async function packItems(choices: Choices): Promise<AccessItem[]> {
  return (await contextPacks.list()).flatMap((pack) =>
    pack.kind === 'role'
      ? []
      : [
          {
            kind: 'pack',
            id: pack.id,
            name: pack.name,
            detail: pack.description === '' ? null : pack.description,
            default_enabled: pack.linked_by_default,
            override: choices[pack.id] ?? null,
            enabled: choices[pack.id] ?? pack.linked_by_default,
            jump_for: [],
            missing_key: [],
            in_set: false,
            session: null,
          },
        ],
  )
}

async function pluginItems(choices: Choices): Promise<AccessItem[]> {
  return (await setiPlugins.list()).map((plugin) => ({
    kind: 'plugin',
    id: plugin.id,
    name: plugin.name,
    detail: plugin.version === null ? plugin.path : `${plugin.version}, ${plugin.path}`,
    default_enabled: plugin.enabled,
    override: choices[plugin.id] ?? null,
    enabled: pluginLoaded(plugin, choices),
    jump_for: [],
    missing_key: [],
    in_set: false,
    session: null,
  }))
}

/**
 * Every item an agent may reach with its default, as a new agent gets it before any choice. SSH
 * hosts and AWS are off unless the user turns their default on.
 */
export async function accessCatalog(): Promise<AccessDefault[]> {
  const items = [
    ...(await sshItems({}, null)),
    await awsItem({}, null),
    ...(await mcpItems(null)),
    ...(await packItems({})),
    ...(await pluginItems({})),
  ]
  return items.map(({ kind, id, name, detail, default_enabled }) => ({ kind, id, name, detail, default_enabled }))
}

/**
 * Everything the agent may reach: each item's default, the agent's override, stored only while it
 * differs, and the outcome. Routes, the sandbox and its proxy, setupKey and task.md read this.
 */
export async function effectiveAccess(task: Task): Promise<TaskAccessView> {
  const items = [
    ...(await sshItems(await taskAccess.all(task.id, 'ssh'), task.profile_id)),
    await awsItem(await taskAccess.all(task.id, 'aws'), task.profile_id),
    ...(await mcpItems(task)),
    ...(await packItems(await taskContextPacks.choices(task.id))),
    ...(await pluginItems(await taskPluginChoices.get(task.id))),
  ]
  const isSandboxed = await sandboxed(task)
  return {
    task_id: task.id,
    sandboxed: isSandboxed,
    items,
    profile: { id: task.profile_id, name: (await profiles.get(task.profile_id))?.name ?? task.profile_id },
    seti_control: task.seti_control,
    hosts: await taskHosts.list(task.id),
    aws: await taskAwsOutcome(task),
    github: await taskGitHubOutcome(task),
  }
}

/** The ssh a task gets, read fresh: its credential's logins for the hosts its access enables. */
export async function taskSsh(taskId: string): Promise<SshReach> {
  const profileId = (await tasks.get(taskId))?.profile_id ?? DEFAULT_PROFILE_ID
  return reachFor(profileId, await taskAccess.all(taskId, 'ssh'))
}

const pick = (items: readonly AccessDefault[], kind: AccessKind, id: string) => {
  const found = items.find((item) => item.kind === kind && item.id === id)
  if (found === undefined) {
    throw new HttpError(404, `No ${KIND_LABEL[kind]} ${id}`)
  }
  return found
}

/** One item's default, for a task when given; MCP servers are not probed for it. */
async function defaultOf(kind: AccessKind, id: string, taskId: string | null = null): Promise<AccessDefault> {
  switch (kind) {
    case 'ssh':
      return pick(await sshItems({}, null), kind, id)
    case 'aws':
      return pick([await awsItem({}, null)], kind, id)
    case 'mcp':
      return { kind, id, name: id, detail: null, default_enabled: await mcpDefaultFor(id, taskId) }
    case 'pack':
      return pick(await packItems({}), kind, id)
    case 'plugin':
      return pick(await pluginItems({}), kind, id)
  }
}

async function overridesOf(taskId: string, kind: AccessKind): Promise<Choices> {
  switch (kind) {
    case 'ssh':
    case 'aws':
      return taskAccess.all(taskId, kind)
    case 'mcp':
      return taskMcpChoices.get(taskId)
    case 'pack':
      return taskContextPacks.choices(taskId)
    case 'plugin':
      return taskPluginChoices.get(taskId)
  }
}

async function storeOverride(task: Task, kind: AccessKind, id: string, override: boolean | null) {
  switch (kind) {
    case 'ssh':
    case 'aws':
      await taskAccess.set(task.id, kind, id, override)
      return
    case 'mcp': {
      const others = Object.entries(await taskMcpChoices.get(task.id)).filter(([name]) => name !== id)
      await taskMcpChoices.set(task.id, Object.fromEntries(override === null ? others : [...others, [id, override]]))
      return
    }
    case 'pack':
      await taskContextPacks.setOne(task.id, id, override)
      signalWorkspaces('packs', task.id)
      return
    case 'plugin':
      await taskPluginChoices.setOne(task.id, id, override)
  }
}

const itemLabel = (kind: AccessKind, name: string) => (kind === 'aws' ? AWS_NAME : `${KIND_LABEL[kind]} ${name}`)

const verbOf = (enabled: boolean, override: boolean | null) =>
  `${enabled ? 'Turned on' : 'Turned off'}${override === null ? ' (the default)' : ''}`

/**
 * Turns one item on or off for a task, or with null drops its override so the default applies.
 * A choice equal to the default is stored as no override. The session restarts at its next turn.
 */
export async function setTaskAccess(
  task: Task,
  { kind, id, enabled }: TaskAccessInput,
  actor: AuditActor = 'user',
): Promise<TaskAccessView> {
  refuseAgent("change an agent's access")
  const item = await defaultOf(kind, id, task.id)
  if (kind === 'ssh' && enabled === false && (await setHosts.forProfile(task.profile_id)).includes(id)) {
    const set = (await profiles.get(task.profile_id))?.name ?? task.profile_id
    throw new HttpError(409, `${id} comes with the credential ${set}; take it out of the credential or pick another`)
  }
  const current = (await overridesOf(task.id, kind))[id] ?? null
  const override = enabled === null ? null : overrideFor(item, enabled)
  if (override === current) {
    return effectiveAccess(task)
  }
  await storeOverride(task, kind, id, override)
  const now = override ?? item.default_enabled
  await audit.record({
    actor,
    kind: AUDIT_KIND[kind],
    subject_type: 'task',
    subject_id: task.id,
    summary: `${verbOf(now, override)} ${itemLabel(kind, item.name)} for task "${task.title}"`,
    detail: {
      title: task.title,
      access: kind,
      item: id,
      name: item.name,
      enabled: now,
      override,
      default_enabled: item.default_enabled,
    },
  })
  signalWorkspaces('task', task.id)
  if (kind === 'ssh') {
    await reloadSshAgents()
  }
  return effectiveAccess(task)
}

/**
 * Turns AWS on for a task the user gives a credential with a role. AWS stays the user's
 * choice: when the EA changes the credential, AWS stays as it was.
 */
export async function awsWithProfile(task: Task, actor: AuditActor): Promise<void> {
  if (actor !== 'user' || fromEa()) {
    return
  }
  const role = (await profiles.get(task.profile_id))?.aws.role_arn ?? null
  if (role !== null && !(await taskAws(task.id))) {
    await setTaskAccess(task, { kind: 'aws', id: AWS_ACCESS_ID, enabled: true }, actor)
  }
}

/** A new task's override, checked against the defaults before the task exists. */
interface StartOverride {
  kind: AccessKind
  id: string
  enabled: boolean
}

/** Checks a new task's choices and keeps those that differ from the default; 400 when unknown. */
export async function planStartAccess(choices: readonly AccessChoice[]): Promise<StartOverride[]> {
  const plan: StartOverride[] = []
  for (const choice of choices) {
    const item = await defaultOf(choice.kind, choice.id).catch((e: unknown) => {
      throw e instanceof HttpError ? new HttpError(400, e.message) : e
    })
    if (overrideFor(item, choice.enabled) !== null) {
      plan.push(choice)
    }
  }
  return plan
}

/** Stores a new task's overrides without auditing each; its creation event lists the outcome. */
export async function applyStartAccess(task: Task, plan: readonly StartOverride[]): Promise<void> {
  for (const choice of plan) {
    await storeOverride(task, choice.kind, choice.id, choice.enabled)
  }
}

/** The SSH hosts and AWS a task ends up with, for its creation event. */
export async function accessSummary(task: Task): Promise<{ ssh_hosts: string[]; aws: boolean }> {
  return { ssh_hosts: (await taskSsh(task.id)).enabled, aws: await taskAws(task.id) }
}

async function setStoredDefault(kind: 'ssh' | 'aws', item: AccessDefault, enabled: boolean, actor: AuditActor) {
  if (item.default_enabled === enabled) {
    return
  }
  await accessDefaults.set(kind, item.id, enabled)
  const who = kind === 'ssh' ? `ssh host ${item.name}` : AWS_NAME
  await audit.record({
    actor,
    kind: 'system.access_default_changed',
    subject_type: 'system',
    subject_id: `${kind}:${item.id}`,
    summary: `Turned ${who} ${enabled ? 'on' : 'off'} by default for agents without their own choice`,
    detail: { access: kind, item: item.id, enabled },
  })
  signalWorkspaces('task')
  if (kind === 'ssh') {
    await reloadSshAgents()
  }
}

/**
 * Sets what every agent without an override gets. SSH hosts and AWS are stored here; MCP servers,
 * packs and plugins go through their own settings, which audit the change themselves.
 */
export async function setAccessDefault(
  kind: AccessKind,
  id: string,
  enabled: boolean,
  actor: AuditActor = 'user',
): Promise<AccessDefault[]> {
  refuseAgent('change what agents get by default')
  const item = await defaultOf(kind, id)
  switch (kind) {
    case 'ssh':
    case 'aws':
      await setStoredDefault(kind, item, enabled, actor)
      break
    case 'mcp':
      await setMcpDefault(id, enabled)
      break
    case 'pack':
      await setPackLinkedByDefault(id, enabled)
      break
    case 'plugin':
      await setDefaultPluginEnabled(id, enabled)
  }
  return accessCatalog()
}
