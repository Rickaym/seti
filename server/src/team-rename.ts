import { handleCandidates, type Task } from '@seti/shared'
import { audit } from './audit.js'
import { teamMembers } from './store/team.js'
import { publishTeam } from './team-events.js'
import { handleChoices, teamMemberOf } from './team.js'

/** Gives a renamed task the first free handle its new title suggests, once it has a handle. */
export async function rehandleAfterRename(task: Pick<Task, 'id' | 'title'>): Promise<void> {
  const member = await teamMembers.get(task.id)
  if (member === undefined || handleCandidates(task.title).includes(member.handle)) {
    return
  }
  for (const handle of handleChoices(task.title)) {
    if (handle === member.handle) {
      return
    }
    if (await teamMembers.setHandle(task.id, handle)) {
      await audit.record({
        actor: 'system',
        kind: 'team.member_changed',
        subject_type: 'task',
        subject_id: task.id,
        summary: `For task "${task.title}": renamed @${member.handle} to @${handle} with the agent`,
        detail: { title: task.title, handle, previous_handle: member.handle, muted: member.muted },
      })
      publishTeam({ type: 'member', member: await teamMemberOf(task.id) })
      return
    }
  }
}
