import { z } from 'zod'
import type { DocPath } from './settings-doc-modified.js'
import { SETTINGS_SECTIONS, type SettingsSectionPath } from './settings-doc-sections.js'
import type { SettingsDoc } from './settings-doc.js'

/** The most settings one JSON write may name, as paths; a whole document stays well below it. */
const PATCH_PATHS_MAX = 2000

const docPath = z.array(z.string().max(300)).min(1).max(12)

/** A JSON write: a merge patch of the document, what the client saw, and what the user confirmed. */
export const settingsPatchInput = z.strictObject({
  /** The revision of the document the client edited. */
  base_revision: z.string().regex(/^[0-9a-f]{64}$/),
  /** An RFC 7396 merge patch of the document: null removes a named item or sets a setting to null. */
  patch: z.record(z.string(), z.unknown()),
  /** The value the client saw at each path it changes; a missing value means none was there. */
  expect: z
    .array(z.strictObject({ path: docPath, value: z.unknown().optional() }))
    .max(PATCH_PATHS_MAX)
    .default([]),
  /** The changes with a consequence the user confirmed, by the ids a refusal named. */
  confirm: z.array(z.string().max(300)).max(50).default([]),
})
export type SettingsPatchInput = z.input<typeof settingsPatchInput>

/** Why a JSON write was refused at one path; `page` is the settings page where it changes instead. */
export interface SettingsProblem {
  path: DocPath
  message: string
  page?: string
}

/** A change the user confirms before it applies, with what follows from it. */
export interface SettingsConfirm {
  id: string
  consequence: string
}

/** What a refused write answers besides its message, under `error`. */
export interface SettingsWriteRefusal {
  title: 'Invalid' | 'Not writable' | 'Changed since' | 'Confirm'
  detail: string
  problems: SettingsProblem[]
  confirm: SettingsConfirm[]
}

/** What a JSON write answers: the document now, the revision to undo it by, and what changed. */
export interface SettingsPatchResult {
  doc: SettingsDoc
  /** Null when the patch changed nothing. */
  revision: number | null
  changed: DocPath[]
}

/** The plain settings a JSON write may change, by section; the rest change on their own pages. */
export const JSON_WRITABLE: Partial<Record<SettingsSectionPath, readonly string[]>> = {
  'app.general': ['name', 'theme'],
  'app.notifications': ['tiers'],
  'app.ea': ['wake_enabled', 'wake_phrase', 'keep_awake_seconds', 'join_on_open', 'form_of_address', 'language'],
  'agents.lifecycle': ['auto_archive', 'compaction', 'dreaming'],
  'agents.resources': ['memory_cap', 'cpu_cap'],
  'capabilities.mcp_servers': ['defaults'],
}

/** Plain settings that JSON shows but does not change, with why. */
export const JSON_READ_ONLY: Partial<Record<SettingsSectionPath, Record<string, string>>> = {
  'agents.repos': { repos: 'Repos are added and removed on the Repos page' },
  'agents.channels': { channels: 'Channels carry code, so they change on the Channels page' },
  'capabilities.plugins': { folders: 'Plugin folders are paths on this machine, so they change on the Plugins page' },
}

const MOD_SWITCH = 'Mods are turned on and off on the Mods page'

const isSection = (path: string): path is SettingsSectionPath => Object.hasOwn(SETTINGS_SECTIONS, path)

/** Keys that name an object's prototype in JavaScript, which no setting is called. */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function modRefusal(key: string, rest: readonly string[]): Omit<SettingsProblem, 'path'> | null {
  if (key === 'settings' && rest.length > 0) {
    return null
  }
  return { message: key === 'enabled' ? MOD_SWITCH : 'Only the settings of a mod change here', page: 'mods' }
}

/** Why a JSON write may not change a path, or null when it may. */
export function jsonWriteRefusal(path: DocPath): Omit<SettingsProblem, 'path'> | null {
  const [group = '', page = '', key = '', ...rest] = path
  if (path.some((part) => PROTOTYPE_KEYS.has(part))) {
    return { message: 'Not a setting' }
  }
  if (group === 'mods') {
    return modRefusal(key, rest)
  }
  const sectionPath = `${group}.${page}`
  if (!isSection(sectionPath)) {
    return { message: 'Not a setting' }
  }
  const section = SETTINGS_SECTIONS[sectionPath]
  const security = section.security === 'all' || (section.security as readonly string[]).includes(key)
  if (security) {
    return { message: 'A security setting: only you change it, on its own page', page: section.page }
  }
  if (JSON_WRITABLE[sectionPath]?.includes(key) === true) {
    return null
  }
  const readOnly = JSON_READ_ONLY[sectionPath] ?? {}
  const why = Object.hasOwn(readOnly, key) ? readOnly[key] : undefined
  return { message: why ?? 'Not a setting', page: section.page }
}
