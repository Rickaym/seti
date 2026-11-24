import { z } from 'zod'
import type { ModSettingField } from './mod-contributions.js'

/** The shape of the settings document; a rename or removal of a key bumps it. */
export const SETTINGS_DOC_VERSION = 1

/** The settings groups the user sees, in order: the document's top-level sections. */
export const SETTINGS_DOC_GROUPS = ['app', 'agents', 'capabilities', 'security', 'mods'] as const
export type SettingsDocGroup = (typeof SETTINGS_DOC_GROUPS)[number]

/** All a document ever says of a secret: whether it is set. */
export const SECRET_STATES = ['set', 'not set'] as const
export type SecretState = (typeof SECRET_STATES)[number]

export const secretStateOf = (set: boolean): SecretState => (set ? 'set' : 'not set')

/** A secret's slot: read-only, so a document that carries a value for it is invalid. */
export const secretState = z.enum(SECRET_STATES).meta({ readOnly: true })

/** Who reads a document: the user sees everything, the EA plain configuration only. */
export type SettingsDocReader = 'user' | 'ea'

type Shape = Record<string, z.ZodType>

/** The field a patch-style route schema leaves optional, as the document always holds it. */
export const held = <T extends z.ZodType>(schema: z.ZodOptional<T>): T => schema.unwrap()

/** A strict object whose every key carries its description, so the JSON Schema documents it. */
export function documented<S extends Shape>(shape: S, docs: { [K in keyof S]: string }): z.ZodObject<S> {
  const entries = Object.entries(shape) as [keyof S & string, z.ZodType][]
  const described = Object.fromEntries(entries.map(([key, schema]) => [key, schema.describe(docs[key])]))
  return z.strictObject(described as S)
}

/** Items keyed by a stable name, so an edit or reorder never reads as a delete plus an add. */
export const keyedBy = <T extends z.ZodType>(item: T) => z.record(z.string(), item)

/** What every section has, whatever its keys. */
export interface AnySettingsSection {
  page: string
  description: string
  schema: z.ZodObject
  security: readonly string[] | 'all'
}

/** One section: a settings page's values, the page it mirrors and the keys only the user reads. */
export interface SettingsSection<S extends Shape = Shape> extends AnySettingsSection {
  /** The settings page key, such as `sandbox`; Settings lists it under that page. */
  page: string
  description: string
  schema: z.ZodObject<S>
  /** Security settings: the EA's document leaves these keys out; `all` leaves out the section. */
  security: readonly (keyof S & string)[] | 'all'
}

export const settingsSection = <S extends Shape>(section: SettingsSection<S>): SettingsSection<S> => section

/** The document's path of a section: its group, then its page's name in the document. */
export type SectionPath = `${Exclude<SettingsDocGroup, 'mods'>}.${string}`

/** Which keys of a section a reader sees, or null when the section is not theirs at all. */
export function visibleKeys(section: AnySettingsSection, reader: SettingsDocReader): string[] | null {
  const keys = Object.keys(section.schema.shape)
  if (reader === 'user') {
    return keys
  }
  if (section.security === 'all') {
    return null
  }
  const security: readonly string[] = section.security
  const plain = keys.filter((key) => !security.includes(key))
  return plain.length === 0 ? null : plain
}

/** A section's schema as a reader sees it, or null when none of it is theirs. */
export function sectionFor(section: AnySettingsSection, reader: SettingsDocReader): z.ZodObject | null {
  const keys = visibleKeys(section, reader)
  if (keys === null) {
    return null
  }
  const shape = Object.fromEntries(keys.map((key) => [key, section.schema.shape[key]]))
  return z.strictObject(shape).describe(section.description)
}

/** A mod's declared setting as a schema: Seti owns the form, so the manifest is the schema. */
export function modSettingSchema(field: ModSettingField): z.ZodType {
  const about = field.description === undefined ? field.title : `${field.title}: ${field.description}`
  if (field.type === 'boolean') {
    return z.boolean().describe(about)
  }
  if (field.type === 'number') {
    const min = field.min === undefined ? z.number() : z.number().min(field.min)
    return (field.max === undefined ? min : min.max(field.max)).describe(about)
  }
  const options = field.options
  if (options !== undefined && options.length > 0) {
    return z.enum(options as [string, ...string[]]).describe(about)
  }
  return z.string().max(field.maxLength).describe(about)
}

/** What the document says of one mod; its settings are validated by its own manifest. */
export interface ModDocShape {
  id: string
  description: string
  settings: { key: string; field: ModSettingField }[]
  /** Only the user turns it on or off, so the EA's document leaves `enabled` out. */
  userSwitch: boolean
}

function modSchema(mod: ModDocShape, reader: SettingsDocReader): z.ZodObject {
  const settings = z.strictObject(
    Object.fromEntries(mod.settings.map(({ key, field }) => [key, modSettingSchema(field)])),
  )
  const enabled = z.boolean().describe('Whether the mod is on')
  const fields = {
    ...(reader === 'ea' && mod.userSwitch ? {} : { enabled }),
    settings: settings.describe('Its settings, as its manifest declares them'),
  }
  return z.strictObject(fields).describe(mod.description)
}

/** The whole document's schema for one reader, from the sections and the mods installed. */
export function settingsDocSchema(
  sections: Readonly<Record<SectionPath, AnySettingsSection>>,
  mods: readonly ModDocShape[],
  reader: SettingsDocReader,
): z.ZodObject {
  const groups: Record<string, Record<string, z.ZodType>> = {}
  for (const [path, section] of Object.entries(sections)) {
    const [group = '', page = ''] = path.split('.')
    const schema = sectionFor(section, reader)
    if (schema !== null) {
      groups[group] = { ...groups[group], [page]: schema }
    }
  }
  const body = Object.fromEntries(
    Object.entries(groups).map(([group, pages]) => [group, z.strictObject(pages).describe(GROUP_DOCS[group] ?? group)]),
  )
  const modShape = Object.fromEntries(mods.map((mod) => [mod.id, modSchema(mod, reader)]))
  return z.strictObject({
    version: z.literal(SETTINGS_DOC_VERSION).describe('The shape of this document'),
    revision: z.string().describe('Changes whenever any value in the document does'),
    ...body,
    mods: z.strictObject(modShape).describe(GROUP_DOCS.mods ?? 'mods'),
  })
}

const GROUP_DOCS: Record<string, string> = {
  app: 'Seti itself: your name, theme, notifications and the EA',
  agents: 'How agents live, what they may use and what Seti runs for them',
  capabilities: 'What agents are given by default',
  security: 'What agents may reach and who may sign in; only you change these, in Seti',
  mods: 'Each installed mod, by id',
}

/** A settings document as the API serves it: version, revision, then the groups. */
export type SettingsDoc = { version: typeof SETTINGS_DOC_VERSION; revision: string } & Record<string, unknown>
