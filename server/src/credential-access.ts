import { SECURITY_ACCESS_KINDS, type AccessKind, type Task } from '@seti/shared'
import { accessDefaults, taskAccess, type StoredAccessKind } from './store/access.js'
import { credentialAccess, credentialHosts } from './store/credential-access.js'

type Choices = Readonly<Record<string, boolean>>

/** An agent's own choices over its credential's set: what decides each item before its default. */
export async function followedChoices(profileId: string, kind: AccessKind, own: Choices): Promise<Choices> {
  return { ...(await credentialAccess.of(profileId, kind)), ...own }
}

const LABEL: Record<StoredAccessKind, string> = { ssh: 'SSH', aws: 'AWS' }

async function kindGain(task: Pick<Task, 'id' | 'profile_id'>, profileId: string, kind: StoredAccessKind) {
  const [own, before, after, defaults] = await Promise.all([
    taskAccess.all(task.id, kind),
    credentialAccess.of(task.profile_id, kind),
    credentialAccess.of(profileId, kind),
    accessDefaults.all(kind),
  ])
  const on = (set: Choices, id: string) => set[id] ?? defaults[id] ?? false
  return Object.keys(after)
    .filter((id) => own[id] === undefined && on(after, id) && !on(before, id))
    .map((id) => (kind === 'aws' ? LABEL.aws : `${LABEL[kind]} ${id}`))
}

/** The SSH hosts, AWS and hosts that moving the agent to another credential would turn on. */
export async function securityGain(task: Pick<Task, 'id' | 'profile_id'>, profileId: string): Promise<string[]> {
  const kinds = SECURITY_ACCESS_KINDS.filter((kind): kind is StoredAccessKind => kind === 'ssh' || kind === 'aws')
  const [gains, before, after] = await Promise.all([
    Promise.all(kinds.map(async (kind) => kindGain(task, profileId, kind))),
    credentialHosts.list(task.profile_id),
    credentialHosts.list(profileId),
  ])
  return [...gains.flat(), ...after.filter((host) => !before.includes(host)).map((host) => `host ${host}`)]
}
