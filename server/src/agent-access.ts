import {
  accessBase,
  AWS_ACCESS_ID,
  DEFAULT_PROFILE_ID,
  overrideFor,
  type AccessChoice,
  type AccessDefault,
  type AccessItem,
  type AccessKind,
  type AuditActor,
  type AuditKind,
  type Task,
  type TaskAccessInput,
  type TaskAccessView,
} from '@seti/shared'
import { audit } from './audit.js'
import { AWS_NAME, awsItem, sandboxed, taskAws, taskAwsOutcome, taskGitHubOutcome } from './aws-access.js'
import { setPackLinkedByDefault } from './context-changes.js'
import { tasks } from './db.js'
import { fromEa, refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { mcpItems } from './mcp-access.js'
import { mcpDefaultFor, setMcpDefault } from './mcp-selection.js'
import { pluginLoaded, setDefaultPluginEnabled } from './plugins.js'
import { sshKeysChanged } from './proxy-owner.js'
import { hostMap, sshReach, sshRoute, type SshReach } from './ssh-config.js'
import { accessDefaults, taskAccess } from './store/access.js'
import { taskHosts } from './store/change-requests.js'
import { contextPacks, taskContextPacks } from './store/context.js'
import { credentialAccess } from './store/credential-access.js'
import { profiles } from './store/credentials.js'
import { taskMcpChoices } from './store/mcp.js'
import { setiPlugins, taskPluginChoices } from './store/plugins.js'
import { sshHostStore } from './store/ssh.js'
import { signalWorkspaces } from './workspace/dir.js'

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

/** Hosts on by the agent's own choice, else its credential's set, else their default. */
async function sshGrants(profileId: string, overrides: Choices) {
  const [list, defaults, set] = await Promise.all([
    sshHostStore.list(),
    accessDefaults.all('ssh'),
    credentialAccess.of(profileId, 'ssh'),
  ])
  const enabled = list
    .map((host) => host.alias)
    .filter((alias) => overrides[alias] ?? set[alias] ?? defaults[alias] ?? false)
  return { list, defaults, set, reach: sshReach(list, enabled) }
}

const reachFor = async (profileId: string, overrides: Choices): Promise<SshReach> =>
  (await sshGrants(profileId, overrides)).reach

async function sshItems(overrides: Choices, profileId: string | null): Promise<AccessItem[]> {
  const { list, defaults, set, reach } = await sshGrants(profileId ?? '', overrides)
  const rows = hostMap(list)
  return list.map((host) => ({
    kind: 'ssh',
    id: host.alias,
    name: host.alias,
    detail: sshRoute(rows, host.alias),
    default_enabled: defaults[host.alias] ?? false,
    credential: set[host.alias] ?? null,
    override: overrides[host.alias] ?? null,
    enabled: reach.enabled.includes(host.alias),
    jump_for: reach.jumpFor.get(host.alias) ?? [],
    missing_key: reach.missing.get(host.alias) ?? [],
    session: null,
    unusable: null,
  }))
}

/** Reference packs only: an agent's role pack is picked in its settings, one at a time. */
async function packItems(choices: Choices, set: Choices = {}): Promise<AccessItem[]> {
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
            credential: set[pack.id] ?? null,
            override: choices[pack.id] ?? null,
            enabled: choices[pack.id] ?? set[pack.id] ?? pack.linked_by_default,
            jump_for: [],
            missing_key: [],
            session: null,
            unusable: null,
          },
        ],
  )
}

async function pluginItems(choices: Choices, set: Choices = {}): Promise<AccessItem[]> {
  return (await setiPlugins.list()).map((plugin) => ({
    kind: 'plugin',
    id: plugin.id,
    name: plugin.name,
    detail: plugin.version === null ? plugin.path : `${plugin.version}, ${plugin.path}`,
    default_enabled: plugin.enabled,
    credential: set[plugin.id] ?? null,
    override: choices[plugin.id] ?? null,
    enabled: pluginLoaded(plugin, { ...set, ...choices }),
    jump_for: [],
    missing_key: [],
    session: null,
    unusable: null,
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
    ...(await packItems(await taskContextPacks.choices(task.id), await credentialAccess.of(task.profile_id, 'pack'))),
    ...(await pluginItems(await taskPluginChoices.get(task.id), await credentialAccess.of(task.profile_id, 'plugin'))),
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

/** One item's default and the task's credential's choice for it. */
async function baseOf(kind: AccessKind, id: string, task: Pick<Task, 'id' | 'profile_id'>) {
  const credential = (await credentialAccess.of(task.profile_id, kind))[id] ?? null
  return { ...(await defaultOf(kind, id, task.id)), credential }
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

const verbOf = (enabled: boolean, override: boolean | null, credential: boolean | null) => {
  const base = credential === null ? ' (the default)' : " (its credential's choice)"
  return `${enabled ? 'Turned on' : 'Turned off'}${override === null ? base : ''}`
}

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
  const item = await baseOf(kind, id, task)
  const current = (await overridesOf(task.id, kind))[id] ?? null
  const override = enabled === null ? null : overrideFor(item, enabled)
  if (override === current) {
    return effectiveAccess(task)
  }
  await storeOverride(task, kind, id, override)
  const now = override ?? accessBase(item)
  await audit.record({
    actor,
    kind: AUDIT_KIND[kind],
    subject_type: 'task',
    subject_id: task.id,
    summary: `${verbOf(now, override, item.credential)} ${itemLabel(kind, item.name)} for task "${task.title}"`,
    detail: {
      title: task.title,
      access: kind,
      item: id,
      name: item.name,
      enabled: now,
      override,
      default_enabled: item.default_enabled,
      credential: item.credential,
    },
  })
  signalWorkspaces('task', task.id)
  if (kind === 'ssh') {
    await sshKeysChanged()
  }
  return effectiveAccess(task)
}

/**
 * Turns AWS on for a task the user gives a credential with a role, unless the credential's set
 * decides AWS. AWS stays the user's choice: when the EA changes the credential, AWS stays.
 */
export async function awsWithProfile(task: Task, actor: AuditActor): Promise<void> {
  if (actor !== 'user' || fromEa() || AWS_ACCESS_ID in (await credentialAccess.of(task.profile_id, 'aws'))) {
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

/**
 * Checks a new task's choices and keeps every off and each on that differs from its base, so no
 * later default or credential set lifts an off it started with; 400 when unknown.
 */
export async function planStartAccess(choices: readonly AccessChoice[], profileId: string): Promise<StartOverride[]> {
  const plan: StartOverride[] = []
  for (const choice of choices) {
    const item = await defaultOf(choice.kind, choice.id).catch((e: unknown) => {
      throw e instanceof HttpError ? new HttpError(400, e.message) : e
    })
    const credential = (await credentialAccess.of(profileId, choice.kind))[choice.id] ?? null
    if (!choice.enabled || overrideFor({ ...item, credential }, choice.enabled) !== null) {
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
    await sshKeysChanged()
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
