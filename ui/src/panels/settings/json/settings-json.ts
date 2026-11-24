import type { SettingsDoc } from '@seti/shared'

/** One card of the JSON page: a settings page's section, or one mod. */
export interface DocSection {
  /** Its dotted path in the document, such as `agents.lifecycle`. */
  path: string
  group: string
  value: unknown
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The document's sections in its own order: each group's pages, then each mod. */
export function docSections(doc: SettingsDoc): DocSection[] {
  return Object.entries(doc).flatMap(([group, pages]) =>
    isObject(pages) ? Object.entries(pages).map(([page, value]) => ({ path: `${group}.${page}`, group, value })) : [],
  )
}

/** The part of a value whose paths or values contain the query, or undefined when none does. */
export function pruned(value: unknown, query: string, path: string): unknown {
  if (path.toLowerCase().includes(query)) {
    return value
  }
  if (isObject(value)) {
    const kept = Object.entries(value).flatMap(([key, child]) => {
      const part = pruned(child, query, `${path}.${key}`)
      return part === undefined ? [] : [[key, part] as const]
    })
    return kept.length === 0 ? undefined : Object.fromEntries(kept)
  }
  return JSON.stringify(value).toLowerCase().includes(query) ? value : undefined
}

/** The sections of one group, or all, cut down to what matches the search. */
export function shownSections(sections: readonly DocSection[], query: string, group: string | null): DocSection[] {
  const needle = query.trim().toLowerCase()
  return sections.flatMap((section) => {
    if (group !== null && section.group !== group) {
      return []
    }
    const value = needle === '' ? section.value : pruned(section.value, needle, section.path)
    return value === undefined ? [] : [{ ...section, value }]
  })
}

export const asJson = (value: unknown) => JSON.stringify(value, null, 2)

/** The file name of an export, dated so exports from different days sort and differ. */
export const exportName = (at: Date) => `seti-settings-${at.toISOString().slice(0, 10)}.json`
