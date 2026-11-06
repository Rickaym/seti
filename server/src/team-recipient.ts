import type { Task, TeamMention, TeamRecipientKind } from '@seti/shared'
import { tasks } from './db.js'
import { HttpError } from './http.js'
import { teamMembers, type MemberRow } from './store/team.js'

export type TeamAuthor =
  { kind: 'user' } | { kind: 'ea' } | { kind: 'task'; taskId: string } | { kind: 'mod'; modId: string }

export interface TaskRecipient {
  kind: 'task'
  task: Task
  member: MemberRow
}

/** The one member a direct message goes to. */
export type Recipient = { kind: 'ea' } | TaskRecipient

/** The member a direct message names; refuses the author itself, unknown and archived agents. */
export async function recipientOf(author: TeamAuthor, to: string): Promise<Recipient> {
  if (to === 'ea') {
    if (author.kind === 'ea') {
      throw new HttpError(400, 'A direct message goes to another member, not to yourself')
    }
    return { kind: 'ea' }
  }
  const [member] = await teamMembers.byHandles([to])
  const task = member === undefined ? undefined : await tasks.get(member.task_id)
  if (member === undefined || task === undefined) {
    throw new HttpError(404, `No agent has the handle @${to}`)
  }
  if (author.kind === 'task' && author.taskId === task.id) {
    throw new HttpError(400, 'A direct message goes to another member, not to yourself')
  }
  if (task.archived_at !== null) {
    throw new HttpError(409, `@${to} is archived; it gets no messages until the user restores it`)
  }
  return { kind: 'task', task, member }
}

export const recipientFields = (
  to: Recipient,
): { to_kind: TeamRecipientKind; to_task_id: string | null; to_handle: string | null } =>
  to.kind === 'ea'
    ? { to_kind: 'ea', to_task_id: null, to_handle: null }
    : { to_kind: 'task', to_task_id: to.task.id, to_handle: to.member.handle }

/** A direct message mentions its recipient alone, whatever handles its text names. */
export const recipientMention = (to: Recipient): TeamMention =>
  to.kind === 'ea' ? { handle: 'ea', task_id: null } : { handle: to.member.handle, task_id: to.task.id }
