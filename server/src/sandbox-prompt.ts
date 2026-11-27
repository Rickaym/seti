import type { SetiControlLevel, Task } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { sharedMemoryLines } from './agent-memory.js'
import { taskAws } from './aws-access.js'
import { tasks } from './db.js'
import type { SshReach } from './ssh-config.js'
import { connectionRows } from './store/connections.js'
import { profiles } from './store/credentials.js'
import { sandboxPolicy } from './store/sandbox.js'

/** Where a sandboxed agent's files live: a private home, or for an older agent the user's too. */
const homeLines = (task: Task) =>
  task.home_access
    ? [
        "You run in Seti's sandbox. The home directory shows the user's code checkouts at their usual paths.",
        'Create new worktrees or clones under ~/work/<name>; other new folders in ~ stay inside the sandbox.',
      ]
    : [
        "You run in Seti's sandbox, in a private home that holds none of the user's files or checkouts.",
        'Only your own folders reach the host; anything else you write in ~ stays inside the sandbox.',
      ]

const SANDBOX_LINES = [
  'Dotfiles, ~/.seti, ~/.ssh, cloud credentials and the Docker socket are not available.',
  "Seti's proxy adds the credentials for GitHub and the Claude API: use https remotes and do not look for tokens.",
]

async function awsLine(task: Task): Promise<string> {
  const profile = await profiles.get(task.profile_id)
  const role = profile?.aws.role_arn ?? null
  const region = profile?.aws.region ?? ''
  if (role === null) {
    return (
      'AWS is on for this task, but its credentials have no role yet, so AWS calls fail until the user ' + 'sets one.'
    )
  }
  return (
    `AWS: the AWS CLI and SDKs get short-lived credentials of ${role} from Seti on their own, in ${region}. ` +
    'The role decides what you may do; do not look for other AWS credentials.'
  )
}

function sshLine(aliases: readonly string[]): string {
  return (
    `SSH reaches only these hosts: ${aliases.join(', ')} (ssh <alias>), and the jump hosts on their way. ` +
    "Users and keys are set per host; keys stay in Seti's ssh-agent and host keys are pinned; other hosts " +
    'are refused. GitHub remotes stay on https.'
  )
}

const OFF_LIST_MAX = 8

/** How the agent gets access that is off: its own request, or the user when it has none. */
const askFor = (level: SetiControlLevel) =>
  level === 'off'
    ? 'The user can turn it on in your access.'
    : 'If your task needs it, ask with request_change kind command, such as /seti:access ssh <alias> on ' +
      'or /seti:access aws on; it applies once the user allows it.'

/** SSH hosts with a login and the AWS role that are off for the agent, and how it asks for them. */
async function offLines(task: Task, ssh: SshReach, aws: boolean): Promise<string[]> {
  const hosts = [...ssh.missing].flatMap(([alias, gaps]) =>
    gaps.length === 0 && !ssh.enabled.includes(alias) ? [alias] : [],
  )
  const role = !aws && ((await profiles.get(task.profile_id))?.aws.role_arn ?? null) !== null
  const more = hosts.length > OFF_LIST_MAX ? [`${String(hosts.length - OFF_LIST_MAX)} more`] : []
  const off = [
    ...(hosts.length === 0 ? [] : [`SSH hosts ${[...hosts.slice(0, OFF_LIST_MAX), ...more].join(', ')}`]),
    ...(role ? ['AWS'] : []),
  ]
  return off.length === 0 ? [] : [`Off for you: ${off.join('; ')}. ${askFor(task.seti_control)}`]
}

/** Names the hosts Seti adds a connection's header on, so the agent calls them without a token. */
async function headersLine(task: Task): Promise<string[]> {
  const rows = (await connectionRows.ofProfile(task.profile_id)).filter((row) => row.header !== null)
  if (rows.length === 0) {
    return []
  }
  const hosts = [...new Set(rows.flatMap((row) => row.hosts))].join(', ')
  return [`Seti's proxy also signs requests to ${hosts}: call them without a token and do not look for one.`]
}

/** Tells a sandboxed agent where its code is, what the sandbox leaves out and what it adds. */
export async function sandboxPrompt(taskId: string): Promise<string | null> {
  const task = await tasks.get(taskId)
  if (task?.sandbox !== true || !(await sandboxPolicy.get()).enabled) {
    return null
  }
  const ssh = await taskSsh(task.id)
  const aws = await taskAws(task.id)
  const extra = [
    ...(await headersLine(task)),
    ...(aws ? [await awsLine(task)] : []),
    ...(ssh.usable.length === 0 ? [] : [sshLine(ssh.usable)]),
    ...(await offLines(task, ssh, aws)),
  ]
  return [...homeLines(task), ...SANDBOX_LINES, ...extra, ...sharedMemoryLines(task)].join('\n')
}
