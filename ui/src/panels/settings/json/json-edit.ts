import {
  diffPatch,
  jsonWriteRefusal,
  isJsonObject,
  JSON_WRITABLE,
  patchPaths,
  valueAt,
  type DocPath,
  type SettingsDoc,
  type SettingsPatchInput,
} from '@seti/shared'
import type { JsonSchema } from './json-complete'
import { parseErrorLine } from './json-scan'
import type { DocSection } from './settings-json'

/** One changed setting as the preview shows it. */
export interface ChangeRow {
  path: DocPath
  before: unknown
  after: unknown
}

/** A planned save: what changes, and the body to send; or why the text cannot be saved. */
export type SavePlan =
  { ok: true; rows: ChangeRow[]; body: SettingsPatchInput } | { ok: false; message: string; line: number | null }

const pick = (value: unknown, keys: readonly string[]) =>
  isJsonObject(value) ? Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]])) : {}

/** The part of the document JSON may change: each writable key, and each mod's settings. */
export function editableDoc(doc: SettingsDoc): Record<string, unknown> {
  const groups: Record<string, Record<string, unknown>> = {}
  for (const [path, keys] of Object.entries(JSON_WRITABLE)) {
    const [group = '', page = ''] = path.split('.')
    const section = pick(valueAt(doc, [group, page]), keys)
    if (Object.keys(section).length > 0) {
      groups[group] = { ...groups[group], [page]: section }
    }
  }
  const mods = isJsonObject(doc.mods) ? doc.mods : {}
  const withSettings = Object.entries(mods).flatMap(([id, mod]) =>
    isJsonObject(mod) && isJsonObject(mod.settings) && Object.keys(mod.settings).length > 0
      ? [[id, { settings: mod.settings }] as const]
      : [],
  )
  return { ...groups, mods: Object.fromEntries(withSettings) }
}

/** The served schema cut down to what the editor holds, so completion offers only writable keys. */
export function editableSchema(schema: JsonSchema): JsonSchema {
  const groups: Record<string, JsonSchema> = {}
  for (const [path, keys] of Object.entries(JSON_WRITABLE)) {
    const [group = '', page = ''] = path.split('.')
    const section = schema.properties?.[group]?.properties?.[page]
    if (section !== undefined) {
      const properties = Object.fromEntries(
        keys.flatMap((key) => {
          const child = section.properties?.[key]
          return child === undefined ? [] : [[key, child] as const]
        }),
      )
      const pages = groups[group]?.properties ?? {}
      groups[group] = { type: 'object', properties: { ...pages, [page]: { ...section, properties } } }
    }
  }
  const mods = Object.entries(schema.properties?.mods?.properties ?? {}).map(([id, mod]): [string, JsonSchema] => [
    id,
    { ...mod, properties: { settings: mod.properties?.settings ?? {} } },
  ])
  return { type: 'object', properties: { ...groups, mods: { type: 'object', properties: Object.fromEntries(mods) } } }
}

export const editableText = (doc: SettingsDoc) => JSON.stringify(editableDoc(doc), null, 2)

/** The smallest parts that differ, for the preview: objects on both sides recurse. */
function rowsOf(before: unknown, after: unknown, path: DocPath = []): ChangeRow[] {
  if (isJsonObject(before) && isJsonObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    return [...keys].flatMap((key) => rowsOf(before[key], after[key], [...path, key]))
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, before, after }]
}

/** Reads the edited text against the document it started from, and plans the write. */
export function planSave(doc: SettingsDoc, text: string, confirm: string[] = []): SavePlan {
  let edited: unknown
  try {
    edited = JSON.parse(text)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Not valid JSON'
    return { ok: false, message: `Not valid JSON: ${message}`, line: parseErrorLine(text, message) }
  }
  const base = editableDoc(doc)
  const patch = diffPatch(base, edited)
  if (!isJsonObject(patch)) {
    return { ok: false, message: 'Nothing changed', line: null }
  }
  const expect = patchPaths(patch).map((path) => {
    const value = valueAt(base, path)
    return value === undefined ? { path: [...path] } : { path: [...path], value }
  })
  return { ok: true, rows: rowsOf(base, edited), body: { base_revision: doc.revision, patch, expect, confirm } }
}

/** A setting's value for the preview, short enough to read on a phone. */
export function shown(value: unknown): string {
  if (value === undefined) {
    return 'none'
  }
  const text = JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/** The settings of a section that differ from their default and that JSON may set back. */
export function resettable(section: DocSection): ChangeRow[] {
  if (section.modified === 0) {
    return []
  }
  const base = section.path.split('.')
  return patchPaths(diffPatch(section.defaults, section.value)).flatMap((rest) => {
    const path = [...base, ...rest]
    const before = valueAt(section.value, rest)
    const after = valueAt(section.defaults, rest)
    return jsonWriteRefusal(path) === null && after !== undefined ? [{ path, before, after }] : []
  })
}
