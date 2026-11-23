import {
  changedKeys,
  type AuditActor,
  type AuditDetail,
  type RevisionObjectRef,
  type RevisionState,
} from '@seti/shared'
import { redactSecrets } from './scrub.js'
import { revisions } from './store/revisions.js'

/** Who makes a change: the user, an agent through a Seti tool, or Seti itself, with the reason. */
export interface ChangeSource {
  actor: AuditActor
  taskId: string | null
  reason: string | null
}

export interface Saved<T> {
  value: T
  /** The recorded revision, or null when the save changed nothing. */
  revision: number | null
}

export const byUser = (reason: string | null = null): ChangeSource => ({ actor: 'user', taskId: null, reason })

export const byAgent = (taskId: string, reason: string): ChangeSource => ({ actor: 'agent', taskId, reason })

export const bySystem = (taskId: string, reason: string): ChangeSource => ({ actor: 'system', taskId, reason })

/** Stores a revision unless nothing changed; returns its id, or null when before equals after. */
export async function recordRevision(
  source: ChangeSource,
  ref: RevisionObjectRef,
  before: RevisionState | null,
  after: RevisionState,
): Promise<number | null> {
  if (before !== null && changedKeys(before, after).length === 0) {
    return null
  }
  const revision = await revisions.insert({
    actor: source.actor,
    task_id: source.taskId,
    ...ref,
    before,
    after,
    reason: source.reason === null ? null : redactSecrets(source.reason),
  })
  return revision.id
}

/** Audit detail that ties an agent change to its task, reason and revision. */
export function sourceDetail(source: ChangeSource, revision: number | null): AuditDetail {
  return {
    ...(source.taskId === null ? {} : { task_id: source.taskId }),
    ...(source.reason === null ? {} : { reason: source.reason }),
    ...(revision === null ? {} : { revision }),
  }
}
