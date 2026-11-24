import { createHash } from 'node:crypto'
import {
  isSecurityAccess,
  type AccessItem,
  type AccessSaveChange,
  type AccessSavePreview,
  type Task,
} from '@seti/shared'
import { effectiveAccess, storeOverride } from './agent-access.js'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { refuseDelegates } from './ea-guard.js'
import { HttpError } from './http.js'
import { sshKeysChanged } from './proxy-owner.js'
import { taskHosts } from './store/change-requests.js'
import { credentialAccess, credentialHosts } from './store/credential-access.js'
import { profiles } from './store/credentials.js'
import { signalWorkspaces } from './workspace/dir.js'

const keyOf = (item: Pick<AccessItem, 'kind' | 'id'>) => `${item.kind}:${item.id}`

interface Plan {
  task: Task
  view: Awaited<ReturnType<typeof effectiveAccess>>
  preview: AccessSavePreview
}

async function requireAgent(profileId: string, taskId: string): Promise<Task> {
  const task = await tasks.get(taskId)
  if (task?.archived_at !== null) {
    throw new HttpError(404, 'No such agent')
  }
  if (task.profile_id !== profileId) {
    throw new HttpError(409, 'An agent saves its access only into its own credential')
  }
  if (!task.sandbox) {
    throw new HttpError(409, 'Credentials apply to sandboxed agents only')
  }
  return task
}

/** How the change reaches each other agent: turned, or kept by its own choice. */
function reach(item: AccessItem, was: boolean | null, others: readonly TaskViewOf[]) {
  const turns: string[] = []
  const keeps: string[] = []
  for (const other of others) {
    const own = other.items.get(keyOf(item))
    if (own === undefined) {
      continue
    }
    if (own.override !== null) {
      keeps.push(other.title)
    } else if ((was ?? own.default_enabled) !== item.enabled) {
      turns.push(other.title)
    }
  }
  return { turns, keeps }
}

interface TaskViewOf {
  id: string
  title: string
  items: ReadonlyMap<string, AccessItem>
}

async function plan(profileId: string, taskId: string): Promise<Plan> {
  refuseDelegates("save an agent's access into a credential")
  const profile = await profiles.get(profileId)
  if (profile === undefined) {
    throw new HttpError(404, 'No such credential')
  }
  const task = await requireAgent(profileId, taskId)
  const view = await effectiveAccess(task)
  const [before, hostsBefore, agents] = await Promise.all([
    credentialAccess.all(profileId),
    credentialHosts.list(profileId),
    profiles.agents(profileId),
  ])
  const others: TaskViewOf[] = []
  for (const agent of agents.filter((entry) => entry.id !== task.id)) {
    const other = await tasks.get(agent.id)
    if (other !== undefined) {
      const items = (await effectiveAccess(other)).items
      others.push({ id: other.id, title: other.title, items: new Map(items.map((item) => [keyOf(item), item])) })
    }
  }
  const was = new Map(before.map((entry) => [`${entry.kind}:${entry.id}`, entry.enabled]))
  const changes: AccessSaveChange[] = view.items
    .filter((item) => was.get(keyOf(item)) !== item.enabled)
    .map((item) => {
      const prior = was.get(keyOf(item)) ?? null
      return {
        kind: item.kind,
        id: item.id,
        name: item.name,
        enabled: item.enabled,
        was: prior,
        ...reach(item, prior, others),
      }
    })
    .toSorted((a, b) => Number(isSecurityAccess(b.kind)) - Number(isSecurityAccess(a.kind)))
  const hostsAdded = view.hosts.filter((host) => !hostsBefore.includes(host))
  const own = view.items.filter((item) => item.override !== null)
  const state = {
    before,
    hostsBefore,
    changes,
    hostsAdded,
    agents: others.map((other) => other.id),
    own: own.map((item) => `${keyOf(item)}:${String(item.override)}`),
    ownHosts: view.hosts,
  }
  const preview: AccessSavePreview = {
    profile: { id: profile.id, name: profile.name },
    agents: others.map((other) => other.title),
    changes,
    hosts_added: hostsAdded,
    own_cleared: own.length,
    own_hosts_cleared: view.hosts.length,
    fingerprint: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
  }
  return { task, view, preview }
}

/** What saving the agent's access into its credential would change, before the user confirms. */
export async function previewAccessSave(profileId: string, taskId: string): Promise<AccessSavePreview> {
  return (await plan(profileId, taskId)).preview
}

/**
 * Copies the agent's access into its credential, which its other agents follow from their next
 * turn, and clears the agent's own choices and hosts, which the credential now gives it.
 */
export async function saveAccess(profileId: string, taskId: string, expect: string): Promise<AccessSavePreview> {
  const { task, view, preview } = await plan(profileId, taskId)
  if (expect !== preview.fingerprint) {
    throw new HttpError(409, 'The access changed since the preview; look at it again')
  }
  for (const change of preview.changes) {
    await credentialAccess.set(profileId, change.kind, change.id, change.enabled)
  }
  for (const host of preview.hosts_added) {
    await credentialHosts.set(profileId, host, true)
  }
  for (const item of view.items.filter((entry) => entry.override !== null)) {
    await storeOverride(task, item.kind, item.id, null)
  }
  for (const host of view.hosts) {
    await taskHosts.remove(task.id, host)
  }
  await profiles.touch(profileId)
  const on = preview.changes.filter((change) => change.enabled).map((change) => `${change.kind}:${change.id}`)
  const off = preview.changes.filter((change) => !change.enabled).map((change) => `${change.kind}:${change.id}`)
  const affected = new Set([
    ...preview.changes.flatMap((change) => change.turns),
    ...(preview.hosts_added.length > 0 ? preview.agents : []),
  ])
  await audit.record({
    actor: 'user',
    kind: 'system.profile_changed',
    subject_type: 'credential_profile',
    subject_id: profileId,
    summary: `Saved the access of "${task.title}" into the credential ${preview.profile.name}`,
    detail: {
      profile: preview.profile.name,
      change: 'access_saved',
      from_agent: task.title,
      turned_on: on,
      turned_off: off,
      hosts_added: preview.hosts_added,
      own_cleared: preview.own_cleared + preview.own_hosts_cleared,
      agents_affected: affected.size,
    },
  })
  signalWorkspaces('task')
  if (preview.changes.some((change) => change.kind === 'ssh')) {
    await sshKeysChanged()
  }
  return { ...preview, changes: [], hosts_added: [], own_cleared: 0, own_hosts_cleared: 0 }
}
