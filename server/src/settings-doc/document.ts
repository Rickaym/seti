import { createHash } from 'node:crypto'
import {
  SETTINGS_DOC_VERSION,
  SETTINGS_SECTIONS,
  diffPatch,
  isJsonObject,
  settingsDocSchema,
  visibleKeys,
  type ModDocShape,
  type ModInfo,
  type SettingsDoc,
  type SettingsDocReader,
  type SettingsSectionPath,
} from '@seti/shared'
import { z } from 'zod'
import { currentRequestSource } from '../access.js'
import { HttpError } from '../http.js'
import { listMods } from '../mods/actions.js'
import { SECTION_DEFAULTS } from './defaults.js'
import { APP_AGENT_READERS, type SectionReaders } from './read-agents.js'
import { SECURITY_READERS } from './read-security.js'

const READERS: SectionReaders<SettingsSectionPath> = { ...APP_AGENT_READERS, ...SECURITY_READERS }

/**
 * Who reads the settings document: the user whole, the EA its plain configuration. Agents, mods
 * and paired devices are refused, here and not only at the route.
 */
export function settingsDocReader(): SettingsDocReader {
  const via = currentRequestSource()?.via
  if (via === 'ea') {
    return 'ea'
  }
  if (via === 'agent' || via === 'mod' || via === 'device') {
    throw new HttpError(403, 'Only the user and the EA read the settings document')
  }
  return 'user'
}

/** Only the user turns these mods on or off, so the EA's document leaves out their switch. */
const userSwitch = (mod: ModInfo) => mod.tier === 'third-party' || mod.security_sensitive || mod.required

const modShape = (mod: ModInfo): ModDocShape => ({
  id: mod.id,
  description: mod.display_name,
  settings: mod.settings.map(({ key, field }) => ({ key, field })),
  userSwitch: userSwitch(mod),
})

type ModValue = (mod: ModInfo) => { enabled: boolean; settings: Record<string, unknown> }

const current: ModValue = (mod) => ({
  enabled: mod.enabled,
  settings: Object.fromEntries(mod.settings.map(({ key, value }) => [key, value])),
})

const byDefault: ModValue = (mod) => ({
  enabled: mod.required || (mod.manifest?.defaultEnabled ?? false),
  settings: Object.fromEntries(mod.settings.map(({ key, field }) => [key, field.default])),
})

function modEntry(mod: ModInfo, reader: SettingsDocReader, value: ModValue) {
  const { enabled, settings } = value(mod)
  return reader === 'ea' && userSwitch(mod) ? { settings } : { enabled, settings }
}

type SectionValue = (path: SettingsSectionPath) => Promise<Record<string, unknown>>

const stored: SectionValue = async (path) => READERS[path]()

/** A section's defaults; some lists default per item, so they start from what is stored. */
const defaults: SectionValue = async (path) => {
  const toDefault = SECTION_DEFAULTS[path] as (
    value: unknown,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
  return toDefault(await READERS[path]())
}

async function sectionValue(path: SettingsSectionPath, reader: SettingsDocReader, read: SectionValue) {
  const keys = visibleKeys(SETTINGS_SECTIONS[path], reader)
  if (keys === null) {
    return null
  }
  const value = await read(path)
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}

/** A document from its body: the version, then a revision that changes with any value. */
export const withRevision = (body: Record<string, unknown>): SettingsDoc => ({
  version: SETTINGS_DOC_VERSION,
  revision: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  ...body,
})

async function docBody(reader: SettingsDocReader, read: SectionValue, mod: ModValue): Promise<Record<string, unknown>> {
  const groups: Record<string, Record<string, unknown>> = {}
  for (const path of Object.keys(SETTINGS_SECTIONS) as SettingsSectionPath[]) {
    const value = await sectionValue(path, reader, read)
    if (value !== null) {
      const [group = '', page = ''] = path.split('.')
      groups[group] = { ...groups[group], [page]: value }
    }
  }
  const { mods } = await listMods()
  return { ...groups, mods: Object.fromEntries(mods.map((info) => [info.id, modEntry(info, reader, mod)])) }
}

/**
 * The settings document for the caller, from the stores the settings pages read; `modified`
 * keeps only what differs from the defaults, as a merge patch onto them.
 */
export async function settingsDoc({ modified = false }: { modified?: boolean } = {}): Promise<SettingsDoc> {
  const reader = settingsDocReader()
  const body = await docBody(reader, stored, current)
  const doc = withRevision(body)
  if (!modified) {
    return doc
  }
  const changed = diffPatch(await docBody(reader, defaults, byDefault), body)
  return { version: doc.version, revision: doc.revision, ...(isJsonObject(changed) ? changed : {}) }
}

/** What every setting the caller reads is until someone changes it. */
export async function settingsDocDefaults(): Promise<SettingsDoc> {
  return withRevision(await docBody(settingsDocReader(), defaults, byDefault))
}

/** The zod schema of the caller's document, which validates a JSON write whole. */
export async function settingsDocZod(): Promise<z.ZodObject> {
  const { mods } = await listMods()
  return settingsDocSchema(SETTINGS_SECTIONS, mods.map(modShape), settingsDocReader())
}

/** The JSON Schema of the caller's document, generated from the routes' own zod schemas. */
export async function settingsDocJsonSchema(): Promise<Record<string, unknown>> {
  const schema = await settingsDocZod()
  return {
    ...z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
    title: 'Seti settings',
  }
}
