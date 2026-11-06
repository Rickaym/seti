import net from 'node:net'
import {
  agentAllowed,
  grantScopes,
  hostAllowed,
  setiSubdomainOf,
  SETI_HOSTNAMES,
  type ModCapability,
  type ModCapabilityName,
  type ModGrantScopes,
  type Task,
} from '@seti/shared'
import { PUBLIC_ACCESS } from '../config.js'
import { tasks } from '../db.js'
import { HttpError } from '../http.js'
import type { ModCall } from './capabilities.js'
import { rolePacksByTask } from '../store/context.js'
import { teamMembers } from '../store/team.js'

/** What a mod holds, from its grant rows: each capability, and the connection the user bound. */
export function grantedFrom(rows: readonly { capability: ModCapability; connection_id: string | null }[]): {
  grants: ModCapabilityName[]
  scopes: ModGrantScopes
} {
  const capabilities = rows.map((row) => row.capability)
  const scopes = grantScopes(capabilities)
  const bound = rows.find((row) => row.capability.name === 'connection')
  if (scopes.connection !== undefined) {
    scopes.connection.connectionId = bound?.connection_id ?? null
  }
  return { grants: capabilities.map((capability) => capability.name), scopes }
}

/** The scope the mod holds for a capability; refuses a mod that was not granted it. */
export function grantOf<K extends ModCapabilityName>(call: ModCall, name: K): NonNullable<ModGrantScopes[K]> {
  const scope = call.scopes[name]
  if (scope === undefined || !call.grants.includes(name)) {
    throw new HttpError(403, `The mod ${call.modId} was not granted ${name}`)
  }
  return scope
}

/** The agent filter that bounds which agents a mod reads and manages; undefined for every agent. */
export const readFilter = (call: ModCall): readonly string[] | undefined => call.scopes['tasks.read']?.agents

/** Whether an agent filter covers a task, by its group chat handle or its role pack, read once. */
export async function filterOf(filter: readonly string[] | undefined): Promise<(taskId: string) => boolean> {
  if (filter === undefined || filter.length === 0) {
    return () => true
  }
  const [members, roles] = await Promise.all([teamMembers.list(), rolePacksByTask()])
  const handles = new Map(members.map((member) => [member.task_id, member.handle]))
  return (taskId) =>
    agentAllowed(filter, { handle: handles.get(taskId) ?? null, role: roles.get(taskId)?.name ?? null })
}

export const filterCovers = async (filter: readonly string[] | undefined, taskId: string): Promise<boolean> =>
  (await filterOf(filter))(taskId)

/** The refusal of a task the mod may not see; the same text as a task that does not exist. */
const taskNotFound = () => new HttpError(404, 'Task not found')

/** The task when the filter covers it; a task outside the filter answers like a missing one. */
export async function visibleTask(filter: readonly string[] | undefined, id: string): Promise<Task> {
  const task = await tasks.get(id)
  if (task === undefined || !(await filterCovers(filter, task.id))) {
    throw taskNotFound()
  }
  return task
}

/** Why a host is Seti itself, which no mod reaches whatever it was granted; null otherwise. */
export function setiHostProblem(host: string): string | null {
  const lower = host.toLowerCase()
  const name = lower.endsWith('.') ? lower.slice(0, -1) : lower
  const seti =
    SETI_HOSTNAMES.has(name) ||
    name.endsWith('.localhost') ||
    setiSubdomainOf(name) !== null ||
    name === PUBLIC_ACCESS?.hostname
  return seti ? `${host} is Seti itself, which mods never reach` : null
}

/** The URL a mod's fetch may go to: https on port 443, a granted name, never an address or Seti. */
export function fetchTarget(call: ModCall, raw: string, hosts: readonly string[], capability: string): URL {
  if (!URL.canParse(raw)) {
    throw new HttpError(400, 'fetch needs an absolute https URL')
  }
  const url = new URL(raw)
  if (url.protocol !== 'https:') {
    throw new HttpError(403, `A mod fetches only https URLs, not ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new HttpError(403, 'A mod puts credentials in a header, never in the URL')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (url.port !== '' && url.port !== '443') {
    throw new HttpError(403, `A mod reaches ${host} on port 443 only, not ${url.port}`)
  }
  if (net.isIP(host) !== 0) {
    throw new HttpError(403, `A mod names a host, never the address ${host}`)
  }
  const seti = setiHostProblem(host)
  if (seti !== null) {
    throw new HttpError(403, seti)
  }
  if (!hostAllowed(hosts, host)) {
    throw new HttpError(403, `The mod ${call.modId} was not granted ${capability} for ${host}`)
  }
  return url
}
