import { parseMentions, type Task, type TeamMessage, type TeamPosted } from '@seti/shared'
import { tasks } from './db.js'
import { HttpError } from './http.js'
import { teamMessages, type MemberRow } from './store/team.js'
import { auditPost } from './team-audit.js'
import { publishTeam } from './team-events.js'
import { stripSelfHeader } from './team-header.js'
import { authorFields, ensureMember, handOverAll, postDirect, resolveMentions, type Plan } from './team.js'

/** The task that asked the EA, with its current handle; null for the user or a deleted task. */
async function askerOf(asked: TeamMessage): Promise<{ task: Task; member: MemberRow } | null> {
  const task = asked.author_task_id === null ? undefined : await tasks.get(asked.author_task_id)
  return task ? { task, member: await ensureMember(task) } : null
}

/** The message the EA answers: one that mentioned it in public, or a direct message to it. */
async function askedOf(replyTo: number): Promise<TeamMessage> {
  const asked = await teamMessages.get(replyTo)
  if (asked === undefined) {
    throw new HttpError(404, 'No group chat message with that id')
  }
  const mentioned = asked.to_kind === null && asked.mentions.some((mention) => mention.handle === 'ea')
  if (asked.author_kind === 'ea' || !(mentioned || asked.to_kind === 'ea')) {
    throw new HttpError(400, 'That message did not mention @ea')
  }
  return asked
}

/** A direct message gets a direct answer, so the reply never reaches the public chat. */
async function replyDirect(asker: { task: Task; member: MemberRow } | null, text: string, replyTo: number) {
  if (asker === null) {
    throw new HttpError(409, 'The agent that sent that direct message is gone; nothing was sent')
  }
  if (asker.task.archived_at !== null) {
    throw new HttpError(409, `@${asker.member.handle} is archived; nothing was sent`)
  }
  const fields = { ...(await authorFields({ kind: 'ea' })), text }
  return postDirect({ kind: 'ea' }, fields, { kind: 'task', ...asker }, replyTo)
}

/**
 * The EA answers a message that mentioned it. The reply names the agent that asked and reaches
 * only that task, at its next step or in a new turn, never cutting a running turn short; a
 * direct message gets a direct reply. Mentioning anyone else is a post that needs the user's yes.
 */
export async function replyToMention(replyTo: number, posted: string): Promise<TeamPosted> {
  const text = stripSelfHeader(posted, 'ea')
  const asked = await askedOf(replyTo)
  const asker = await askerOf(asked)
  const handle = asker?.member.handle ?? null
  const others = parseMentions(text).filter((mention) => mention !== handle && mention !== 'user')
  if (others.length > 0) {
    const named = others.map((mention) => `@${mention}`).join(', ')
    throw new HttpError(400, `A reply reaches only the agent that asked; ${named} needs a post the user agreed to`)
  }
  if (asked.to_kind === 'ea') {
    return replyDirect(asker, text, replyTo)
  }
  const body = handle === null || parseMentions(text).includes(handle) ? text : `@${handle} ${text}`
  const { mentions, unknown } = await resolveMentions(parseMentions(body))
  const message = await teamMessages.insert({ ...(await authorFields({ kind: 'ea' })), text: body, mentions })
  publishTeam({ type: 'message', message })
  await auditPost({ kind: 'ea' }, message, replyTo)
  const archived = asker !== null && asker.task.archived_at !== null ? [asker.member.handle] : []
  const targets: Plan[] =
    asker === null || archived.length > 0
      ? []
      : [
          {
            ...asker,
            kind: 'mention',
            priority: 'next',
            skip: asker.member.muted ? 'muted' : null,
            hold: null,
            startIdle: true,
          },
        ]
  return { message, deliveries: await handOverAll(message, targets), unknown, archived }
}
