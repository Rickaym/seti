import { changedKeys, contextPackInput, writeContextFileInput, type Revision, type RevisionState } from '@seti/shared'
import { z } from 'zod'
import { packState, requirePack, saveContextFile, updatePack } from './context-changes.js'
import { readContextFile } from './context-files.js'
import { describeIssues, HttpError } from './http.js'
import { restoreKnowledge } from './knowledge-review.js'
import { byUser, type ChangeSource } from './revisions.js'
import { revisions } from './store/revisions.js'

/** The current state with the given fields set back to their values in `before`. */
function restoreFields(current: RevisionState, before: RevisionState, fields: readonly string[]): RevisionState {
  const merged: RevisionState = { ...current }
  for (const key of fields) {
    const value = before[key]
    if (value !== undefined) {
      merged[key] = value
    }
  }
  return Object.fromEntries(Object.entries(merged).filter(([key]) => !fields.includes(key) || key in before))
}

function parseState<T extends z.ZodType>(schema: T, state: RevisionState): z.output<T> {
  const parsed = schema.safeParse(state)
  if (!parsed.success) {
    throw new HttpError(409, `This revision no longer applies: ${describeIssues(parsed.error)}`)
  }
  return parsed.data
}

const fileState = z.object({ content: writeContextFileInput.shape.content })

async function restore(
  target: Revision,
  before: RevisionState,
  fields: readonly string[],
  source: ChangeSource,
): Promise<number | null> {
  const id = target.object_id
  switch (target.object_type) {
    case 'context_pack': {
      const next = restoreFields(packState(await requirePack(id)), before, fields)
      return (await updatePack(id, parseState(contextPackInput, next), source)).revision
    }
    case 'context_file': {
      const { content } = parseState(fileState, before)
      return (await saveContextFile(id, content, (await readContextFile(id)).hash, source)).revision
    }
    case 'knowledge_note':
      return restoreKnowledge(id, before, fields, source)
  }
}

/** Sets the fields a revision changed back to their earlier values, as a new user revision. */
export async function revertRevision(id: number): Promise<Revision> {
  const target = await revisions.get(id)
  if (!target) {
    throw new HttpError(404, 'Revision not found')
  }
  if (target.before === null || target.after === null) {
    throw new HttpError(400, 'Only a change to an existing object can be reverted')
  }
  const fields = changedKeys(target.before, target.after)
  const created = await restore(target, target.before, fields, byUser(`Reverted revision #${String(id)}`))
  const revision = created === null ? undefined : await revisions.get(created)
  if (!revision) {
    throw new HttpError(409, 'Nothing to revert: the object already has the earlier values')
  }
  return revision
}
