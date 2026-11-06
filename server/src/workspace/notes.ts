import { REVISION_NOTE_MAX, type RevisionObjectRef } from '@seti/shared'
import { audit } from '../audit.js'
import { byAgent, sourceDetail } from '../revisions.js'
import { revisions } from '../store/revisions.js'

/** Records an agent's note in the history of a pack, audited as the agent. */
export async function addNote(taskId: string, ref: RevisionObjectRef, label: string, text: string): Promise<number> {
  const clipped = text.slice(0, REVISION_NOTE_MAX)
  const source = byAgent(taskId, clipped)
  const note = await revisions.insert({
    actor: 'agent',
    task_id: taskId,
    ...ref,
    before: null,
    after: null,
    reason: clipped,
  })
  await audit.record({
    actor: 'agent',
    kind: 'seti.note_added',
    subject_type: ref.object_type,
    subject_id: ref.object_id,
    summary: `Agent left a note on ${label}: ${clipped}`,
    detail: sourceDetail(source, note.id),
  })
  return note.id
}
