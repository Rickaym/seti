import { createHash } from 'node:crypto'
import {
  SETTINGS_DOC_VERSION,
  SETTINGS_SECTIONS,
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
import { APP_AGENT_READERS, type SectionReaders } from './read-agents.js'
import { SECURITY_READERS } from './read-security.js'

const READERS: SectionReaders<SettingsSectionPath> = { ...APP_AGENT_READERS, ...SECURITY_READERS }

/**
 * Who reads the settings document: the user whole, the EA its plain configuration. Agents, mods
 * and paired devices are refused, here and not only at the route.
 */
function settingsDocReader(): SettingsDocReader {
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

function modEntry(mod: ModInfo, reader: SettingsDocReader) {
  const settings = Object.fromEntries(mod.settings.map(({ key, value }) => [key, value]))
  return reader === 'ea' && userSwitch(mod) ? { settings } : { enabled: mod.enabled, settings }
}

async function sectionValue(path: SettingsSectionPath, reader: SettingsDocReader) {
  const keys = visibleKeys(SETTINGS_SECTIONS[path], reader)
  if (keys === null) {
    return null
  }
  const value: Record<string, unknown> = await READERS[path]()
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}

/** The settings document for the caller, from the stores the settings pages read. */
export async function settingsDoc(): Promise<SettingsDoc> {
  const reader = settingsDocReader()
  const groups: Record<string, Record<string, unknown>> = {}
  for (const path of Object.keys(SETTINGS_SECTIONS) as SettingsSectionPath[]) {
    const value = await sectionValue(path, reader)
    if (value !== null) {
      const [group = '', page = ''] = path.split('.')
      groups[group] = { ...groups[group], [page]: value }
    }
  }
  const { mods } = await listMods()
  const body = { ...groups, mods: Object.fromEntries(mods.map((mod) => [mod.id, modEntry(mod, reader)])) }
  const revision = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return { version: SETTINGS_DOC_VERSION, revision, ...body }
}

/** The JSON Schema of the caller's document, generated from the routes' own zod schemas. */
export async function settingsDocJsonSchema(): Promise<Record<string, unknown>> {
  const reader = settingsDocReader()
  const { mods } = await listMods()
  const schema = settingsDocSchema(SETTINGS_SECTIONS, mods.map(modShape), reader)
  return {
    ...z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
    title: 'Seti settings',
  }
}
