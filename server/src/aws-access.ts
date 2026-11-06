import {
  AWS_ACCESS_ID,
  AWS_SETTINGS_DEFAULT,
  awsRoleName,
  type AccessItem,
  type AwsOutcome,
  type GitHubOutcome,
  type Task,
} from '@seti/shared'
import { knownHostRole } from './aws-credentials.js'
import { githubTokens } from './secrets.js'
import { accessDefaults, taskAccess } from './store/access.js'
import { profiles } from './store/credentials.js'
import { sandboxPolicy } from './store/sandbox.js'

export const AWS_NAME = 'AWS'

/** Whether the task runs in the sandbox, where its credential applies. */
export const sandboxed = async (task: Task) => task.sandbox && (await sandboxPolicy.get()).enabled

const awsDetail = ({ name, aws }: { name: string; aws: { role_arn: string | null; region: string } }) =>
  aws.role_arn === null ? `no role in ${name}` : `${awsRoleName(aws.role_arn)} (${aws.region})`

/** The AWS switch with the role of the agent's credential as its detail. */
export async function awsItem(
  overrides: Readonly<Record<string, boolean>>,
  profileId: string | null,
): Promise<AccessItem> {
  const byDefault = (await accessDefaults.all('aws'))[AWS_ACCESS_ID] ?? false
  const override = overrides[AWS_ACCESS_ID] ?? null
  const profile = profileId === null ? undefined : await profiles.get(profileId)
  return {
    kind: 'aws',
    id: AWS_ACCESS_ID,
    name: AWS_NAME,
    detail: profile === undefined ? null : awsDetail(profile),
    default_enabled: byDefault,
    override,
    enabled: override ?? byDefault,
    jump_for: [],
    missing_key: [],
    in_set: false,
    session: null,
  }
}

/** Whether the task's sandbox gets AWS credentials of its credential's role. */
export async function taskAws(taskId: string): Promise<boolean> {
  const override = (await taskAccess.all(taskId, 'aws'))[AWS_ACCESS_ID]
  return override ?? (await accessDefaults.all('aws'))[AWS_ACCESS_ID] ?? false
}

/** What the agent's AWS calls run as; unsandboxed, the host's own identity, whatever its switch. */
export async function taskAwsOutcome(task: Task): Promise<AwsOutcome> {
  const profile = await profiles.get(task.profile_id)
  const region = profile?.aws.region ?? AWS_SETTINGS_DEFAULT.region
  if (!(await sandboxed(task))) {
    return { state: 'host', host_role: knownHostRole(region) }
  }
  const role = profile?.aws.role_arn ?? null
  if (role === null) {
    return { state: 'no_role', profile: profile?.name ?? task.profile_id }
  }
  return { state: (await taskAws(task.id)) ? 'on' : 'off', role, region }
}

/** The GitHub tokens the agent's proxy adds; unsandboxed, the host's own login. */
export async function taskGitHubOutcome(task: Task): Promise<GitHubOutcome> {
  if (!(await sandboxed(task))) {
    return { state: 'host' }
  }
  const status = await githubTokens(task.profile_id).status()
  const owners = status.owners.map((token) => token.owner)
  return status.default.configured || owners.length > 0
    ? { state: 'set', default: status.default.configured, owners }
    : { state: 'none' }
}
