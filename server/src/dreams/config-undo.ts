import type { DreamTidy } from '@seti/shared'
import { audit } from '../audit.js'
import { refuseAgent } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { dreamTidies } from '../store/dream-tidies.js'
import { requireTask } from '../tasks.js'
import { signalWorkspaces } from '../workspace/dir.js'

/**
 * Undoes a configuration change Seti applied for a dream: puts the subscription back with its id,
 * filter, delivery and history. The user's, or the EA's after the user's yes; agents and mods are
 * refused. A subscription put back this way is never listed for a dream again.
 */
export async function undoTidy(id: number): Promise<DreamTidy> {
  refuseAgent("undo a dream's change")
  const found = await dreamTidies.get(id)
  if (found === undefined) {
    throw new HttpError(404, 'No such change')
  }
  const { tidy, before } = found
  if (tidy.state !== 'applied') {
    throw new HttpError(409, 'It was undone already')
  }
  const task = await requireTask(tidy.task_id)
  if (task.archived_at !== null) {
    throw new HttpError(409, `Restore "${task.title}" before undoing this`)
  }
  const refused = await dreamTidies.restore(id, before)
  if (refused !== null) {
    throw new HttpError(409, `Not undone: ${refused}`)
  }
  signalWorkspaces('task', task.id)
  await audit.record({
    actor: 'user',
    kind: 'dream.tidy_undone',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Undid a dream's change of ${task.title}: subscribed again to ${tidy.label}`,
    detail: { tidy: id, run: tidy.run_id, channel: tidy.label, channel_id: before.channel_id },
  })
  return (await dreamTidies.get(id))?.tidy ?? tidy
}
