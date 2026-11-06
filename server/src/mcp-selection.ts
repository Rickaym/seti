import os from 'node:os'
import {
  fromMcpChoices,
  mcpEnabled,
  type AuditActor,
  type McpChoices,
  type McpSelectionEntry,
  type McpSelectionKind,
  type McpServer,
  type Task,
  type TaskMcpServer,
} from '@seti/shared'
import { audit } from './audit.js'
import { capabilityCache } from './capabilities.js'
import { tasks } from './db.js'
import { refuseAgent } from './ea-guard.js'
import { isBorrowed, localServers, ownProjects, readHostConfig, tilde } from './mcp-borrowed.js'
import { mcpGone } from './mcp-presence.js'
import { mcpDefaults, taskMcpChoices } from './store/mcp.js'
import { signalWorkspaces } from './workspace/dir.js'

const byName = (a: string, b: string) => a.localeCompare(b, 'en')

export function selectionKind(server: McpServer): McpSelectionKind {
  if (server.transport?.type === 'claudeai-proxy' || server.scope === 'claudeai') {
    return 'connector'
  }
  return server.source === 'plugin' ? 'plugin' : 'config'
}

/** The servers of every probe this process holds, first probe first, one row per name. */
export function knownServers(snapshots = capabilityCache.all()): McpServer[] {
  const seen = new Map<string, McpServer>()
  for (const server of snapshots.flatMap((snapshot) => snapshot.servers)) {
    if (!seen.has(server.name)) {
      seen.set(server.name, server)
    }
  }
  return [...seen.values()]
}

/** Names of the servers an agent leaves out: turned off by its own choice or by default. */
export function deniedServers(defaults: McpChoices, choices: McpChoices): string[] {
  const named = new Set([...Object.keys(defaults), ...Object.keys(choices)])
  return [...named].filter((name) => !mcpEnabled(name, defaults, choices)).toSorted(byName)
}

/** Which servers are local to other directories: for one agent's directories, or for any agent. */
interface LocalScope {
  local: ReadonlyMap<string, readonly string[]>
  borrowed: (name: string) => boolean
}

function localScope(own: readonly string[] | null): LocalScope {
  const local = localServers(readHostConfig())
  return { local, borrowed: isBorrowed(local, own) }
}

/** A server's default: its Default row, else off for a local server of other directories. */
const defaultOf = (name: string, defaults: McpChoices, scope: LocalScope) => defaults[name] ?? !scope.borrowed(name)

/** Every server Seti knows by name: probed ones, and defaults or choices set for others. */
function catalog(
  servers: readonly McpServer[],
  defaults: McpChoices,
  scope: LocalScope,
  choices: McpChoices = {},
): McpSelectionEntry[] {
  const probed = new Map(servers.map((server) => [server.name, selectionKind(server)]))
  const names = new Set([...probed.keys(), ...Object.keys(defaults), ...Object.keys(choices)])
  return [...names].toSorted(byName).map((name) => ({
    name,
    kind: probed.get(name) ?? null,
    default_enabled: defaultOf(name, defaults, scope),
    known: probed.has(name),
    local_to: (scope.local.get(name) ?? []).map((dir) => tilde(dir)),
  }))
}

/** The catalog without servers gone from every config, which a stale probe may still list. */
async function presentCatalog(...args: Parameters<typeof catalog>): Promise<McpSelectionEntry[]> {
  const gone = await mcpGone()
  return catalog(...args).filter((entry) => !gone(entry.name))
}

/** Probes the home scope when nothing is probed yet, so a first visit still lists servers. */
async function probedServers(): Promise<McpServer[]> {
  if (capabilityCache.all().length === 0) {
    await capabilityCache.get(os.homedir()).catch(() => undefined)
  }
  return knownServers()
}

/** Every server with its default; `probe` false lists only what is probed already, at once. */
export async function mcpCatalog(probe = true): Promise<McpSelectionEntry[]> {
  const servers = probe ? await probedServers() : knownServers()
  return presentCatalog(servers, await mcpDefaults.all(), localScope(null))
}

/** The scope of a task's directories; a task that is gone counts as elsewhere. */
async function taskScope(taskId: string): Promise<LocalScope> {
  const task = await tasks.get(taskId)
  return localScope(task === undefined ? null : ownProjects(task.cwd))
}

export async function taskMcpServers(taskId: string, probe = true): Promise<TaskMcpServer[]> {
  const [defaults, choices, scope] = await Promise.all([
    mcpDefaults.all(),
    taskMcpChoices.get(taskId),
    taskScope(taskId),
  ])
  const servers = probe ? await probedServers() : knownServers()
  return (await presentCatalog(servers, defaults, scope, choices)).map((entry) => ({
    ...entry,
    choice: choices[entry.name] ?? null,
    enabled: choices[entry.name] ?? entry.default_enabled,
    borrowed: scope.borrowed(entry.name),
  }))
}

/** One server's default for a task, or for any agent without one, without probing. */
export async function mcpDefaultFor(name: string, taskId: string | null): Promise<boolean> {
  const scope = taskId === null ? localScope(null) : await taskScope(taskId)
  return defaultOf(name, await mcpDefaults.all(), scope)
}

/** Names of the servers a task loads and leaves out, from what is probed already, for task.md. */
export async function taskMcpNames(taskId: string): Promise<{ enabled: string[]; disabled: string[] }> {
  const servers = await taskMcpServers(taskId, false)
  const names = (on: boolean) => servers.filter((s) => s.enabled === on && (s.known || !on)).map((s) => s.name)
  return { enabled: names(true), disabled: names(false) }
}

/** What a task's session leaves out, read at every session start and in its setup key. */
export async function taskDeniedServers(taskId: string): Promise<string[]> {
  const [defaults, choices] = await Promise.all([mcpDefaults.all(), taskMcpChoices.get(taskId)])
  return deniedServers(defaults, choices)
}

/** Connector ids of claude.ai connectors among the named servers, for the sandbox proxy. */
export const connectorIds = (names: readonly string[], servers: readonly McpServer[] = knownServers()) =>
  servers.flatMap((server) =>
    server.connector_id !== null && names.includes(server.name) ? [server.connector_id] : [],
  )

export async function setMcpDefault(name: string, enabled: boolean): Promise<McpSelectionEntry[]> {
  refuseAgent('change which MCP servers agents get by default')
  const fallback = !localScope(null).borrowed(name)
  const before = (await mcpDefaults.all())[name] ?? fallback
  await mcpDefaults.set(name, enabled, fallback)
  if (before !== enabled) {
    await audit.record({
      actor: 'user',
      kind: 'mcp.default_changed',
      subject_type: 'mcp_server',
      subject_id: name,
      summary: `Turned MCP server ${name} ${enabled ? 'on' : 'off'} by default for agents without their own choice`,
      detail: { server: name, enabled },
    })
    signalWorkspaces('task')
  }
  return mcpCatalog()
}

const choiceList = (choices: McpChoices) => {
  const { mcp_enabled, mcp_disabled } = fromMcpChoices(choices)
  return { mcp_enabled, mcp_disabled }
}

/** Replaces a task's choices; the session restarts with them at its next turn. */
export async function setTaskMcpChoices(task: Task, choices: McpChoices, actor: AuditActor = 'user'): Promise<void> {
  const before = await taskMcpChoices.get(task.id)
  await taskMcpChoices.set(task.id, choices)
  const was = choiceList(before)
  const now = choiceList(choices)
  if (JSON.stringify(was) === JSON.stringify(now)) {
    return
  }
  await audit.record({
    actor,
    kind: 'task.mcp_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Changed the MCP servers of task "${task.title}"`,
    detail: { title: task.title, ...now },
  })
  signalWorkspaces('task', task.id)
}
