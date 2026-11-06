import { recipientLabel, type TeamMessage } from '@seti/shared'
import { audit } from './audit.js'
import { authorLabel } from './team-author.js'
import type { TeamAuthor } from './team-recipient.js'

const SUMMARY_CHARS = 120

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** A direct message is audited with who sent it to whom and its length, never its text. */
export async function auditDirect(message: TeamMessage, replyTo?: number): Promise<void> {
  const from = authorLabel(message)
  const to = recipientLabel(message) ?? 'nobody'
  await audit.record({
    actor: message.author_kind === 'task' ? 'agent' : 'user',
    kind: 'team.direct_posted',
    subject_type: message.author_task_id === null ? 'team' : 'task',
    subject_id: message.author_task_id ?? String(message.id),
    summary: `${from} sent a direct message to ${to} (${String(message.text.length)} characters)`,
    detail: {
      message_id: String(message.id),
      author: from,
      to,
      to_task_id: message.to_task_id,
      length: message.text.length,
      ...(replyTo === undefined ? {} : { reply_to: String(replyTo) }),
    },
  })
}

export async function auditPost(author: TeamAuthor, message: TeamMessage, replyTo?: number): Promise<void> {
  await audit.record({
    actor: author.kind === 'task' ? 'agent' : 'user',
    kind: 'team.message_posted',
    subject_type: author.kind === 'task' ? 'task' : 'team',
    subject_id: author.kind === 'task' ? author.taskId : String(message.id),
    summary: `${authorLabel(message)} posted to the team chat: ${clip(oneLine(message.text), SUMMARY_CHARS)}`,
    detail: {
      message_id: String(message.id),
      author: authorLabel(message),
      text: message.text,
      mentions: message.mentions.map((mention) => mention.handle),
      ...(replyTo === undefined ? {} : { reply_to: String(replyTo) }),
    },
  })
}
