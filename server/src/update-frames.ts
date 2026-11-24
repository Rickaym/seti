import {
  SECOND_OPINION_TAG,
  type AgentInput,
  type ChannelInput,
  type PrInput,
  type SetiInput,
  type TaskInput,
  type TeamInput,
  type ThreadInput,
  type WorkspaceInput,
} from '@seti/shared'
import { subtaskNote } from './subtask-prs.js'

const BODY_CHARS = 6000

/** The tags updates reach an agent in; a body may neither open nor close any of them. */
const FRAME_TAGS = [
  'update',
  'team-chat',
  'workspace-edit',
  'channel-event',
  'thread-reply',
  'agent-turn',
  'seti-answer',
  SECOND_OPINION_TAG,
]

/** An attribute value that cannot end its quotes or start a tag. */
export const tagAttribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** Text in which every opening or closing of the named tags, in any case, reads as plain text. */
export function containTags(text: string, tags: readonly string[]): string {
  const names = tags.map((tag) => tag.replace(/[^a-z-]/g, '')).join('|')
  return text.replace(new RegExp(`<([\\s/]*(?:${names}))(?![a-z-])`, 'gi'), '&lt;$1')
}

/** A frame whose attributes are escaped and whose body cannot close it or fake another frame. */
export function tagged(tag: string, attributes: Record<string, string | undefined>, body: string): string {
  const attrs = Object.entries(attributes).flatMap(([name, value]) =>
    value === undefined ? [] : [` ${name}="${tagAttribute(value)}"`],
  )
  return `<${tag}${attrs.join('')}>\n${containTags(body, FRAME_TAGS)}\n</${tag}>`
}

const clip = (text: string) => (text.length <= BODY_CHARS ? text : `${text.slice(0, BODY_CHARS)}\n[... clipped]`)

function describePr(input: PrInput): string {
  const about = input.subtask === undefined ? '' : `\n\n${subtaskNote(input.subtask)}`
  const body = input.body === '' ? '' : `\n\n${clip(input.body)}`
  const url = input.url ?? undefined
  return tagged(
    'update',
    { source: input.source, kind: input.kind, subject: input.subject, url },
    `${input.title}${about}${body}`,
  )
}

/** How to answer a direct message so the answer stays between the two of them. */
function directReply(from: string): string {
  const handle = from.startsWith('@') ? from : `@${from}`
  return `\n\nOnly you, ${from} and the user see this. Answer privately: start a chat.md append with the line \`direct ${handle}\`, or post_team_chat with to.`
}

const describeTeam = (input: TeamInput) =>
  tagged(
    'team-chat',
    { from: input.subject, kind: input.kind, message_id: String(input.message_id) },
    `${clip(input.body)}${input.kind === 'direct' ? directReply(input.subject) : ''}`,
  )

const describeWorkspace = (input: WorkspaceInput) => tagged('workspace-edit', { file: input.subject }, clip(input.body))

function describeChannel(input: ChannelInput): string {
  const body = input.body === '' ? '' : `\n\n${clip(input.body)}`
  return tagged(
    'channel-event',
    {
      channel: input.channel,
      source: input.subject,
      kind: input.kind === '' ? undefined : input.kind,
      severity: input.severity,
      received_at: input.received_at,
      url: input.url ?? undefined,
    },
    `${input.title}${body}`,
  )
}

const describeThread = (input: ThreadInput) =>
  tagged(
    'thread-reply',
    {
      service: input.service,
      from: input.from,
      name: input.subject,
      bot: input.bot ? 'true' : undefined,
      channel: input.channel,
      thread: input.thread,
      received_at: input.received_at,
      url: input.url ?? undefined,
    },
    clip(input.body),
  )

const describeAgent = (input: AgentInput) =>
  tagged(
    'agent-turn',
    { agent: input.subject, task_id: input.task_id, ended: input.kind },
    `${input.title}\n\n${clip(input.body)}`.trimEnd(),
  )

const describeSeti = (input: SetiInput) =>
  tagged('seti-answer', { request_id: input.request_id, outcome: input.kind }, `${input.title}\n${input.body}`)

/** One update in the tag of its source (UPD-13), as the agent reads it. */
export function describeInput(input: TaskInput): string {
  switch (input.source) {
    case 'pr':
      return describePr(input)
    case 'team':
      return describeTeam(input)
    case 'workspace':
      return describeWorkspace(input)
    case 'channel':
      return describeChannel(input)
    case 'thread':
      return describeThread(input)
    case 'agent':
      return describeAgent(input)
    case 'seti':
      return describeSeti(input)
  }
}
