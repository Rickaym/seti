import {
  applyPatch,
  changedKeys,
  isJsonObject,
  patchOf,
  valueAt,
  type DocPath,
  type Revision,
  type RevisionObjectRef,
  type RevisionState,
} from '@seti/shared'
import { HttpError } from '../http.js'

/** Every JSON write is a revision of this one object, so the revisions panel lists them together. */
export const SETTINGS_REVISION: RevisionObjectRef = { object_type: 'settings', object_id: 'settings-doc' }

const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1')
const unescape = (key: string) => key.replaceAll('~1', '/').replaceAll('~0', '~')

/** A path as a JSON Pointer (RFC 6901), the key of a settings revision's state. */
export const pointerOf = (path: DocPath) => path.map((key) => `/${escape(key)}`).join('')

export const pathOf = (pointer: string): string[] => pointer.split('/').slice(1).map(unescape)

/** The smallest parts that changed: objects on both sides recurse, anything else is one part. */
function changedParts(from: unknown, to: unknown, at: DocPath = []): DocPath[] {
  if (isJsonObject(from) && isJsonObject(to)) {
    const keys = new Set([...Object.keys(from), ...Object.keys(to)])
    return [...keys].flatMap((key) => changedParts(from[key], to[key], [...at, key]))
  }
  return JSON.stringify(from) === JSON.stringify(to) ? [] : [at]
}

function stateOf(doc: unknown, parts: DocPath[]): RevisionState {
  return Object.fromEntries(
    parts.flatMap((path) => {
      const value = valueAt(doc, path)
      return value === undefined ? [] : [[pointerOf(path), JSON.stringify(value)]]
    }),
  )
}

/** The revision states of a write: each changed part's value before and after, as JSON text. */
export function revisionStates(
  doc: unknown,
  next: unknown,
  changed: DocPath[],
): { before: RevisionState; after: RevisionState } {
  const sections = new Set(changed.map((path) => pointerOf(path.slice(0, 2))))
  const parts = [...sections].flatMap((pointer) => {
    const path = pathOf(pointer)
    return changedParts(valueAt(doc, path), valueAt(next, path), path)
  })
  return { before: stateOf(doc, parts), after: stateOf(next, parts) }
}

/** A merge patch that sets each part back to its value in a state; a part it lacks is removed. */
function patchFrom(state: RevisionState, keys: readonly string[]): Record<string, unknown> {
  return keys.reduce<Record<string, unknown>>((patch, pointer) => {
    const text = state[pointer]
    const value: unknown = typeof text === 'string' ? JSON.parse(text) : null
    return applyPatch(patch, patchOf(pathOf(pointer), value), () => false) as Record<string, unknown>
  }, {})
}

/** What undoing a settings revision writes: its earlier values, expecting its later ones. */
export function revertChange(target: Revision): {
  patch: Record<string, unknown>
  expect: { path: DocPath; value?: unknown }[]
} {
  if (target.before === null || target.after === null) {
    throw new HttpError(400, 'Only a change to existing settings can be reverted')
  }
  const after = target.after
  const keys = changedKeys(target.before, after)
  const expect = keys.map((pointer) => {
    const text = after[pointer]
    return typeof text === 'string'
      ? { path: pathOf(pointer), value: JSON.parse(text) as unknown }
      : { path: pathOf(pointer) }
  })
  return { patch: patchFrom(target.before, keys), expect }
}
