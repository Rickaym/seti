import { diffPatch, isJsonObject, modifiedPaths, type SettingsDoc } from '@seti/shared'

/** One card of the JSON page: a settings page's section, or one mod. */
export interface DocSection {
  /** Its dotted path in the document, such as `agents.lifecycle`. */
  path: string
  group: string
  value: unknown
  /** Its defaults, or undefined while they load. */
  defaults: unknown
  /** How many of its settings differ from their default. */
  modified: number
}

const isObject = isJsonObject

const defaultOf = (defaults: SettingsDoc | null, group: string, page: string): unknown => {
  const pages = defaults?.[group]
  return isObject(pages) ? pages[page] : undefined
}

/** The document's sections in order, each group's pages then each mod, with their defaults. */
export function docSections(doc: SettingsDoc, defaults: SettingsDoc | null = null): DocSection[] {
  return Object.entries(doc).flatMap(([group, pages]) =>
    isObject(pages)
      ? Object.entries(pages).map(([page, value]) => {
          const base = defaultOf(defaults, group, page)
          const modified = base === undefined ? 0 : modifiedPaths(value, base).length
          return { path: `${group}.${page}`, group, value, defaults: base, modified }
        })
      : [],
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

/** What the page filters by: a search, one group or all, and whether only modified settings show. */
export interface DocFilter {
  query: string
  group: string | null
  modified: boolean
}

/** The part of a section that differs from its defaults, or undefined when nothing does. */
const changedPart = (section: DocSection): unknown =>
  section.modified === 0 ? undefined : diffPatch(section.defaults, section.value)

/** The sections of one group, or all, cut down to what matches the search and the filter. */
export function shownSections(sections: readonly DocSection[], filter: DocFilter): DocSection[] {
  const needle = filter.query.trim().toLowerCase()
  return sections.flatMap((section) => {
    if (filter.group !== null && section.group !== filter.group) {
      return []
    }
    const base = filter.modified ? changedPart(section) : section.value
    const value = needle === '' || base === undefined ? base : pruned(base, needle, section.path)
    return value === undefined ? [] : [{ ...section, value }]
  })
}

export const asJson = (value: unknown) => JSON.stringify(value, null, 2)

/** The file name of an export, dated so exports from different days sort and differ. */
export const exportName = (at: Date) => `seti-settings-${at.toISOString().slice(0, 10)}.json`
