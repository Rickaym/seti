import { memoryFileId, memoryFileOf, type Revision } from '@seti/shared'
import { audit } from '../audit.js'
import { tasks } from '../db.js'
import { HttpError } from '../http.js'
import { bySystem, recordRevision, type ChangeSource } from '../revisions.js'
import { dreamsOf } from '../runtimes/capabilities.js'
import { memoryFileState, memoryPath, memoryState, readMemoryFile, sha256, writeMemoryFile } from './memory-files.js'
import { lineCounts, memoryChanges, type MemorySnapshot } from './memory-snapshot.js'

export interface RecordedChange {
  file: string
  revision: number | null
  added: number
  removed: number
}

/** Records each file that differs between the snapshots as a revision by Seti, and audits it. */
export async function recordMemoryChanges(
  taskId: string,
  reason: string,
  before: MemorySnapshot,
  after: MemorySnapshot,
): Promise<RecordedChange[]> {
  const recorded: RecordedChange[] = []
  for (const change of memoryChanges(before, after)) {
    const ref = { object_type: 'memory_file', object_id: memoryFileId(taskId, change.file) } as const
    const was = change.before?.text ?? null
    const now = change.after?.text ?? null
    const revision = await recordRevision(bySystem(taskId, reason), ref, memoryState(was), memoryState(now))
    const { added, removed } = lineCounts(was ?? '', now ?? '')
    await audit.record({
      actor: 'system',
      kind: 'dream.memory_changed',
      subject_type: 'task',
      subject_id: taskId,
      summary: `Dream changed memory file ${change.file}: ${String(added)} lines added, ${String(removed)} removed`,
      detail: {
        path: change.file,
        added,
        removed,
        bytes_before: Buffer.byteLength(was ?? ''),
        bytes_after: Buffer.byteLength(now ?? ''),
        deleted: now === null,
        revision,
      },
    })
    recorded.push({ file: change.file, revision, added, removed })
  }
  return recorded
}

function parseState(state: unknown) {
  const parsed = memoryFileState.safeParse(state)
  if (!parsed.success) {
    throw new HttpError(409, 'This revision no longer applies: it does not hold a memory file.')
  }
  return parsed.data
}

/**
 * Puts a memory file back as it was before a revision, while the file is still as the revision
 * left it; a later change, or an earlier text Seti kept only redacted, refuses with 409.
 */
export async function revertMemoryFile(target: Revision, source: ChangeSource): Promise<number | null> {
  const ref = memoryFileOf(target.object_id)
  if (ref === null) {
    throw new HttpError(400, 'This revision does not name a memory file.')
  }
  const task = await tasks.get(ref.taskId)
  if (!task) {
    throw new HttpError(404, 'The agent whose memory this was no longer exists.')
  }
  if (task.archived_at !== null) {
    throw new HttpError(409, 'The agent is archived; restore it before changing its memory.')
  }
  const before = parseState(target.before)
  const after = parseState(target.after)
  if (before.redacted === true) {
    throw new HttpError(409, `The earlier ${ref.file} held a credential, which Seti does not keep; edit it by hand.`)
  }
  const memory = dreamsOf(task.runtime)?.memory(task.cwd) ?? null
  if (memory === null) {
    throw new HttpError(409, "The agent's runtime keeps no memory Seti can find.")
  }
  const file = await memoryPath(memory, ref.file)
  if (file === null) {
    throw new HttpError(409, `${ref.file} is not a plain file inside the agent's memory folder.`)
  }
  const current = await readMemoryFile(file)
  if ((current === null ? '' : sha256(current)) !== after.sha256) {
    throw new HttpError(409, `${ref.file} changed after this revision; reverting it would lose that change.`)
  }
  const restored = before.deleted === true ? null : before.text
  await writeMemoryFile(file, restored)
  const revision = await recordRevision(
    { ...source, taskId: task.id },
    { object_type: 'memory_file', object_id: target.object_id },
    memoryState(current === null ? null : current.toString('utf8')),
    memoryState(restored),
  )
  await audit.record({
    actor: source.actor,
    kind: 'dream.reverted',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Put memory file ${ref.file} of ${task.title} back as it was before revision #${String(target.id)}`,
    detail: { path: ref.file, reverted: target.id, revision },
  })
  return revision
}
