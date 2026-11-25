import type { z } from 'zod'
import { isJsonObject, type DocPath } from './settings-doc-modified.js'

/** The schema of the value at one step down, or null when the schema has no such step. */
function child(schema: z.ZodType, key: string): z.ZodType | null {
  const def = schema.def as unknown as Record<string, unknown> & { type: string }
  switch (def.type) {
    case 'object':
      return ((schema as z.ZodObject).shape[key] as z.ZodType | undefined) ?? null
    case 'record':
      return def.valueType as z.ZodType
    case 'nullable':
    case 'optional':
    case 'default':
      return child(def.innerType as z.ZodType, key)
    case 'pipe':
      return child(def.in as z.ZodType, key)
    case 'union':
      return (def.options as z.ZodType[]).map((option) => child(option, key)).find((found) => found !== null) ?? null
    default:
      return null
  }
}

function isRecord(schema: z.ZodType): boolean {
  const def = schema.def as unknown as Record<string, unknown> & { type: string }
  if (def.type === 'record') {
    return true
  }
  const inner = def.innerType ?? def.in
  return inner !== undefined && isRecord(inner as z.ZodType)
}

/** Whether the value at a path lists items by name, so a null in a patch removes one. */
export function keyedAt(schema: z.ZodType, path: DocPath): boolean {
  let at: z.ZodType | null = schema
  for (const key of path) {
    at = at === null ? null : child(at, key)
  }
  return at !== null && isRecord(at)
}

/**
 * A JSON merge patch (RFC 7396) applied to a document. A null removes an item from a list keyed
 * by name and sets any other setting to null, since every setting in the document is required.
 */
export function applyPatch(
  target: unknown,
  patch: unknown,
  keyed: (path: DocPath) => boolean,
  at: DocPath = [],
): unknown {
  if (!isJsonObject(patch)) {
    return patch
  }
  const removes = keyed(at)
  const base = isJsonObject(target) ? target : {}
  const kept = Object.entries(base).filter(([key]) => !(removes && patch[key] === null))
  const result: Record<string, unknown> = Object.fromEntries(kept)
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null || !removes) {
      result[key] = value === null ? null : applyPatch(result[key], value, keyed, [...at, key])
    }
  }
  return result
}

/** The value at a path, or undefined when the document has none there. */
export function valueAt(doc: unknown, path: DocPath): unknown {
  let at = doc
  for (const key of path) {
    at = isJsonObject(at) ? at[key] : undefined
  }
  return at
}

/** The patch that sets one path to a value and leaves the rest alone. */
export function patchOf(path: DocPath, value: unknown): unknown {
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value)
}
