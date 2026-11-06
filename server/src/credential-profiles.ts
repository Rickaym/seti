import {
  AWS_SETTINGS_DEFAULT,
  DEFAULT_PROFILE_ID,
  type AuditDetail,
  type AuditKind,
  type AwsSettings,
  type CredentialProfile,
  type CredentialsOverview,
  type ProfileSummary,
} from '@seti/shared'
import { audit } from './audit.js'
import { awsHostRole } from './aws-credentials.js'
import { HttpError } from './http.js'
import { githubTokens } from './secrets.js'
import { reloadSshAgents } from './ssh-agent.js'
import { profileSshHosts, setSetHost } from './ssh.js'
import { connectionRows } from './store/connections.js'
import { profiles, type ProfileRow } from './store/credentials.js'

const isDefault = (id: string) => id === DEFAULT_PROFILE_ID

async function requireProfile(id: string): Promise<ProfileRow> {
  const profile = await profiles.get(id)
  if (profile === undefined) {
    throw new HttpError(404, 'No such credential')
  }
  return profile
}

async function view(profile: ProfileRow): Promise<CredentialProfile> {
  const [github, connections, agents, hosts] = await Promise.all([
    githubTokens(profile.id).status(),
    connectionRows.profileList(profile.id),
    profiles.agents(profile.id),
    profileSshHosts(profile.id),
  ])
  return { ...profile, builtin: isDefault(profile.id), github, connections, agents, ssh_hosts: hosts }
}

export async function credentialsOverview(): Promise<CredentialsOverview> {
  const list = await profiles.list()
  const region = list.find((profile) => isDefault(profile.id))?.aws.region ?? AWS_SETTINGS_DEFAULT.region
  return { profiles: await Promise.all(list.map(view)), host_role: await awsHostRole(region) }
}

async function profileView(id: string): Promise<CredentialProfile> {
  return view(await requireProfile(id))
}

export async function profileSummaries(): Promise<ProfileSummary[]> {
  const [list, counts] = await Promise.all([profiles.list(), profiles.agentCounts()])
  return list.map((profile) => ({
    id: profile.id,
    name: profile.name,
    builtin: isDefault(profile.id),
    agents: counts.get(profile.id) ?? 0,
  }))
}

/** Names, hosts and settings only: never a secret value, token or mint result. */
async function auditProfile(
  kind: AuditKind,
  profile: { id: string; name: string },
  summary: string,
  detail: AuditDetail,
) {
  await audit.record({
    actor: 'user',
    kind,
    subject_type: 'credential_profile',
    subject_id: profile.id,
    summary,
    detail: { profile: profile.name, ...detail },
  })
}

const nameTaken = (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === '23505'

export async function createProfile(name: string): Promise<CredentialProfile> {
  let created: ProfileRow
  try {
    created = await profiles.create(name)
  } catch (e) {
    throw nameTaken(e) ? new HttpError(409, `A credential named ${name} already exists`) : e
  }
  await auditProfile('system.profile_created', created, `Created the credential ${name}`, {})
  return view(created)
}

export async function renameProfile(id: string, name: string): Promise<CredentialProfile> {
  const before = await requireProfile(id)
  if (isDefault(id)) {
    throw new HttpError(409, 'Default keeps its name')
  }
  try {
    await profiles.rename(id, name)
  } catch (e) {
    throw nameTaken(e) ? new HttpError(409, `A credential named ${name} already exists`) : e
  }
  await auditProfile('system.profile_changed', { id, name }, `Renamed the credential ${before.name} to ${name}`, {
    change: 'renamed',
    previous_name: before.name,
  })
  return profileView(id)
}

/** Deletes a profile; its tasks fall back to Default and its GitHub tokens go with it. */
export async function deleteProfile(id: string): Promise<void> {
  const profile = await requireProfile(id)
  if (isDefault(id)) {
    throw new HttpError(409, 'Default cannot be deleted')
  }
  const agents = await profiles.agents(id)
  const hosts = await profileSshHosts(id)
  await profiles.remove(id)
  await githubTokens(id).clearAll()
  await reloadSshAgents()
  await auditProfile('system.profile_deleted', profile, `Deleted the credential ${profile.name}`, {
    agents_moved_to_default: agents.map((agent) => agent.title),
    ssh_hosts_removed: hosts,
  })
}

/** Bundles an ssh host into the set, or takes it out, for every agent using the set. */
export async function setProfileSshHost(id: string, alias: string, bundled: boolean): Promise<CredentialProfile> {
  await setSetHost(id, alias, bundled)
  return profileView(id)
}

export async function setProfileAws(id: string, aws: Omit<AwsSettings, 'updated_at'>): Promise<CredentialProfile> {
  const before = await requireProfile(id)
  await profiles.setAws(id, aws)
  const summary =
    aws.role_arn === null
      ? `Cleared the AWS role of the credential ${before.name}`
      : `Set the AWS role of the credential ${before.name} to ${aws.role_arn}`
  await auditProfile('system.profile_changed', before, summary, {
    change: 'aws',
    role_arn: aws.role_arn,
    previous_role_arn: before.aws.role_arn,
    external_id_set: aws.external_id !== null,
    external_id_changed: aws.external_id !== before.aws.external_id,
    region: aws.region,
    session_minutes: aws.session_minutes,
  })
  return profileView(id)
}

/** Sets or clears one GitHub token of a profile: the default one when owner is null. */
export async function setProfileGitHub(
  id: string,
  owner: string | null,
  value: string | null,
): Promise<CredentialProfile> {
  const profile = await requireProfile(id)
  const tokens = githubTokens(id)
  const which = owner === null ? 'the default GitHub token' : `the GitHub token for ${owner}`
  if (value === null) {
    const removed = owner === null ? await tokens.clearDefault() : await tokens.clearOwner(owner)
    if (!removed) {
      return view(profile)
    }
  } else if (owner === null) {
    await tokens.setDefault(value)
  } else {
    await tokens.setOwner(owner, value)
  }
  await profiles.touch(id)
  await audit.record({
    actor: 'user',
    kind: value === null ? 'system.secret_cleared' : 'system.secret_set',
    subject_type: 'credential_profile',
    subject_id: id,
    summary: `${value === null ? 'Cleared' : 'Set'} ${which} of the credential ${profile.name}`,
    detail: { profile: profile.name, name: 'github_agent_token', owner },
  })
  return profileView(id)
}
