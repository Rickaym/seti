import type { Task } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { taskAws } from './aws-access.js'
import { tasks } from './db.js'
import { connectionRows } from './store/connections.js'
import { profiles } from './store/credentials.js'
import { sandboxPolicy } from './store/sandbox.js'

const SANDBOX_LINES = [
  "You run in Seti's sandbox. The home directory shows the user's code checkouts at their usual paths.",
  'Create new worktrees or clones under ~/work/<name>; other new folders in ~ stay inside the sandbox.',
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
    'are refused. GitHub remotes stay on https. Only the user gives you more hosts.'
  )
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
  const ssh = (await taskSsh(task.id)).usable
  const extra = [
    ...(await headersLine(task)),
    ...((await taskAws(task.id)) ? [await awsLine(task)] : []),
    ...(ssh.length === 0 ? [] : [sshLine(ssh)]),
  ]
  return [...SANDBOX_LINES, ...extra].join('\n')
}
