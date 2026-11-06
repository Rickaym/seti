import { awsRoleName, type AwsOutcome, type ChannelSubscription, type Task } from '@seti/shared'
import { channelSourceLabel } from '../channels/source-info.js'

export interface TaskView {
  task: Task
  handle: string
  /** Pack files of the reference packs linked to the task. */
  packs: string[]
  /** The role pack linked to the task, with its pack file's slug. */
  role: { name: string; slug: string } | null
  channels: readonly ChannelSubscription[]
  /** MCP servers the task's sessions load and leave out, by name. */
  mcp: { enabled: readonly string[]; disabled: readonly string[] }
  /** Ssh aliases the task reaches, jump hosts only passed through, and what its AWS calls run as. */
  access: { ssh: readonly string[]; jumps: readonly string[]; aws: AwsOutcome }
}

const list = (items: readonly string[]) => (items.length === 0 ? 'none' : items.join(', '))

const channelLine = (sub: ChannelSubscription) =>
  `- ${sub.channel_name} (${channelSourceLabel(sub.preset)}): ${sub.events === null ? 'every event' : sub.events.join(', ')}`

/** The AWS the agent has, and when it has none, the one step that gives it. */
function awsLine(aws: AwsOutcome): string {
  switch (aws.state) {
    case 'on':
      return `- AWS: on, the role ${aws.role} in ${aws.region}`
    case 'off':
      return (
        `- AWS: off. Your credential has the role ${awsRoleName(aws.role)}; ask the user to turn on AWS ` +
        'for you in your settings.'
      )
    case 'no_role':
      return (
        `- AWS: off; your credential ${aws.profile} has no AWS role. Ask the user to give you a ` +
        'credential with one in your settings, which turns AWS on.'
      )
    case 'host': {
      const role = aws.host_role === null ? '' : ` (${aws.host_role})`
      return `- AWS: you run outside the sandbox, so AWS calls use this machine's own role${role}, not your credential.`
    }
  }
}

export function renderTask({ task, handle, packs, role, channels, mcp, access }: TaskView): string {
  const repos = task.repos.map((repo) => `${repo.slug} at ${repo.dir}`)
  const packFiles = packs.map((slug) => `packs/${slug}.md`)
  return [
    '# This task',
    '',
    'Read-only; Seti rewrites it when the task changes.',
    '',
    `- Title: ${task.title}`,
    `- Handle: @${handle}`,
    `- Id: ${task.id}`,
    `- Working directory: ${task.cwd}`,
    `- Repos: ${list(repos)}${task.worktree ? ' (worktrees)' : ''}`,
    `- Sandbox: ${task.sandbox ? 'on' : 'off'}`,
    `- Linked PRs: ${list(task.pr_urls)}`,
    `- Linked context packs: ${list(packFiles)}`,
    '',
    '## Role',
    '',
    'Your standing role comes from one `kind: role` pack, also in your system prompt. Ask @ea in chat.md to',
    'change which role you have.',
    '',
    role === null ? '- none' : `- ${role.name}: packs/${role.slug}.md`,
    '',
    '## Channels',
    '',
    'Events from these channels reach you as updates. Only the user or the EA subscribes you or adds a',
    'channel, such as a poller for a service without webhooks; ask @ea in chat.md for a change.',
    '',
    ...(channels.length === 0 ? ['- none'] : channels.map(channelLine)),
    '',
    '## MCP servers',
    '',
    'Your sessions load the servers that are on. Only the user or the EA changes them; ask @ea in chat.md.',
    '',
    `- On: ${list(mcp.enabled)}`,
    `- Off: ${list(mcp.disabled)}`,
    '',
    '## SSH and AWS',
    '',
    'Only the user gives you ssh hosts or AWS; the EA cannot. They apply while you run in the sandbox.',
    '',
    `- SSH hosts: ${list(access.ssh)}`,
    ...(access.jumps.length === 0 ? [] : [`- Jump hosts on the way: ${list(access.jumps)}`]),
    awsLine(access.aws),
    '',
  ].join('\n')
}
