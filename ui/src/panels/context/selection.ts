import type { PackKind, RevisionObjectRef } from '@seti/shared'

const PACK_PREFIX = 'pack:'
const KNOWLEDGE_PREFIX = 'knowledge:'

/** The Knowledge page's views: proposals waiting, approved notes, and notes gone stale. */
export const KNOWLEDGE_VIEWS = ['proposed', 'approved', 'stale'] as const
export type KnowledgeView = (typeof KNOWLEDGE_VIEWS)[number]

export const knowledgeSelection = (view: KnowledgeView) => `${KNOWLEDGE_PREFIX}${view}`

export const packSelection = (id: string) => `${PACK_PREFIX}${id}`
export const NEW_PACK = packSelection('new')
export const NEW_ROLE = packSelection('new-role')
export const DEFAULT_SELECTION = 'user'

/** A pack by id, or a new one of newKind while id is null. */
export type Selection =
  | { kind: 'file'; key: string }
  | { kind: 'pack'; id: string | null; newKind: PackKind }
  | { kind: 'knowledge'; view: KnowledgeView }

const isView = (value: string): value is KnowledgeView => (KNOWLEDGE_VIEWS as readonly string[]).includes(value)

/** Route ids: a CLAUDE.md file key, pack:<id> for packs and roles, knowledge:<view> for notes. */
export function parseSelection(selection: string): Selection {
  if (selection.startsWith(KNOWLEDGE_PREFIX)) {
    const view = selection.slice(KNOWLEDGE_PREFIX.length)
    return { kind: 'knowledge', view: isView(view) ? view : 'proposed' }
  }
  if (!selection.startsWith(PACK_PREFIX)) {
    return { kind: 'file', key: selection }
  }
  if (selection === NEW_PACK || selection === NEW_ROLE) {
    return { kind: 'pack', id: null, newKind: selection === NEW_ROLE ? 'role' : 'reference' }
  }
  return { kind: 'pack', id: selection.slice(PACK_PREFIX.length), newKind: 'reference' }
}

/** The object whose change history belongs to a selection; null for a pack not saved yet. */
export function revisionRef(selection: Selection): RevisionObjectRef | null {
  if (selection.kind === 'file') {
    return { object_type: 'context_file', object_id: selection.key }
  }
  if (selection.kind === 'knowledge') {
    return null
  }
  return selection.id === null ? null : { object_type: 'context_pack', object_id: selection.id }
}
