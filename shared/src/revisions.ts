import { z } from 'zod'

export const REVISION_OBJECT_TYPES = ['context_pack', 'context_file'] as const
export type RevisionObjectType = (typeof REVISION_OBJECT_TYPES)[number]

export const REVISION_ACTORS = ['user', 'agent'] as const
export type RevisionActor = (typeof REVISION_ACTORS)[number]

export type RevisionValue = string | number | boolean | null | string[]

/** The saved fields of an object at one point in time. */
export type RevisionState = Record<string, RevisionValue>

/** created: before is null; updated: both set; note: neither, the reason holds the note. */
export type RevisionKind = 'created' | 'updated' | 'note'

export interface Revision {
  id: number
  at: string
  actor: RevisionActor
  task_id: string | null
  task_title: string | null
  object_type: RevisionObjectType
  object_id: string
  kind: RevisionKind
  before: RevisionState | null
  after: RevisionState | null
  reason: string | null
}

/** An object whose latest change came from an agent after the user last looked at it. */
export interface UnseenChange {
  object_type: RevisionObjectType
  object_id: string
  revision_id: number
  at: string
  task_id: string | null
}

export const REVISION_REASON_MAX = 500
export const REVISION_NOTE_MAX = 2000

export const revisionObjectRef = z.object({
  object_type: z.enum(REVISION_OBJECT_TYPES),
  object_id: z.string().trim().min(1).max(200),
})
export type RevisionObjectRef = z.infer<typeof revisionObjectRef>

export const revisionParams = z.object({ id: z.coerce.number().int().positive() })

export const revertRevisionInput = z.object({}).strict()

const sameValue = (a: RevisionValue | undefined, b: RevisionValue | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Keys whose value differs between two states, in a stable order. */
export function changedKeys(before: RevisionState | null, after: RevisionState | null): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...keys].filter((key) => !sameValue(before?.[key], after?.[key]))
}
