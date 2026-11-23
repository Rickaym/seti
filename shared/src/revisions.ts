import { z } from 'zod'

export const REVISION_OBJECT_TYPES = ['context_pack', 'context_file', 'knowledge_note', 'memory_file'] as const
export type RevisionObjectType = (typeof REVISION_OBJECT_TYPES)[number]

/** `system` is Seti itself, such as a dream recording the memory files it changed. */
export const REVISION_ACTORS = ['user', 'agent', 'system'] as const
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
  object_id: z.string().trim().min(1).max(300),
})
export type RevisionObjectRef = z.infer<typeof revisionObjectRef>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** One object's history, or every memory file of one agent. */
export const revisionQuery = z.union([
  revisionObjectRef,
  z.object({ object_type: z.literal('memory_file'), task_id: z.string().regex(UUID) }),
])
export type RevisionQuery = z.infer<typeof revisionQuery>

/** A memory file's object id: the agent's id and the file's path inside its memory folder. */
export const memoryFileId = (taskId: string, file: string) => `${taskId}:${file}`

/** The parts of a memory file's object id, or null when it is not one. */
export function memoryFileOf(objectId: string): { taskId: string; file: string } | null {
  const at = objectId.indexOf(':')
  const taskId = objectId.slice(0, at)
  const file = objectId.slice(at + 1)
  return at === -1 || !UUID.test(taskId) || file === '' ? null : { taskId, file }
}

export const revisionParams = z.object({ id: z.coerce.number().int().positive() })

export const revertRevisionInput = z.object({}).strict()

const sameValue = (a: RevisionValue | undefined, b: RevisionValue | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Keys whose value differs between two states, in a stable order. */
export function changedKeys(before: RevisionState | null, after: RevisionState | null): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...keys].filter((key) => !sameValue(before?.[key], after?.[key]))
}
