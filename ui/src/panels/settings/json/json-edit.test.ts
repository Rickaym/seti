import {
  JSON_READ_ONLY,
  JSON_WRITABLE,
  SETTINGS_SECTIONS,
  visibleKeys,
  type SettingsDoc,
  type SettingsSectionPath,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { schemasAt } from './json-complete'
import { editableDoc, editableText, planSave } from './json-edit'
import { contextAt, lineOfPath } from './json-scan'

const DOC = {
  version: 1,
  revision: 'a'.repeat(64),
  app: { ea: { wake_enabled: false, wake_phrase: 'Hey Seti' }, general: { name: 'R', theme: null } },
  security: { sandbox: { enabled: true } },
  mods: { weather: { enabled: true, settings: { units: 'metric' } }, plain: { enabled: true, settings: {} } },
} satisfies SettingsDoc

describe('editing settings as JSON', () => {
  it('decides for every plain setting whether JSON may change it', () => {
    const undecided = Object.entries(SETTINGS_SECTIONS).flatMap(([path, section]) =>
      (visibleKeys(section, 'ea') ?? []).flatMap((key) => {
        const decided =
          JSON_WRITABLE[path as SettingsSectionPath]?.includes(key) === true ||
          JSON_READ_ONLY[path as SettingsSectionPath]?.[key] !== undefined
        return decided ? [] : [`${path}.${key}`]
      }),
    )
    expect(undecided, 'add the key to JSON_WRITABLE or JSON_READ_ONLY in shared/src/settings-doc-write.ts').toEqual([])
  })

  it('holds only writable settings and mods with settings', () => {
    expect(editableDoc(DOC)).toEqual({
      app: { ea: { wake_enabled: false, wake_phrase: 'Hey Seti' }, general: { name: 'R', theme: null } },
      mods: { weather: { settings: { units: 'metric' } } },
    })
  })

  it('plans a merge patch with what the client saw, or names the line of bad JSON', () => {
    const text = editableText(DOC).replace('"metric"', '"imperial"')
    const plan = planSave(DOC, text)
    expect(plan).toMatchObject({
      ok: true,
      rows: [{ path: ['mods', 'weather', 'settings', 'units'], before: 'metric', after: 'imperial' }],
      body: {
        base_revision: DOC.revision,
        patch: { mods: { weather: { settings: { units: 'imperial' } } } },
        expect: [{ path: ['mods', 'weather', 'settings', 'units'], value: 'metric' }],
      },
    })
    expect(planSave(DOC, editableText(DOC))).toMatchObject({ ok: false, message: 'Nothing changed' })
    const broken = planSave(DOC, '{\n  "app": {\n    "general": 1 2\n}')
    expect(broken).toMatchObject({ ok: false, line: 3 })
  })

  it('finds the line of a path and the context at the caret', () => {
    const text = editableText(DOC)
    expect(lineOfPath(text, ['mods', 'weather', 'settings', 'units'])).toBe(
      text.split('\n').findIndex((l) => l.includes('"units"')) + 1,
    )
    const half = '{\n  "app": {\n    "general": {\n      "na'
    expect(contextAt(half, half.length)).toEqual({ kind: 'key', path: ['app', 'general'], from: half.length - 3 })
    const value = '{ "app": { "ea": { "wake_enabled": '
    expect(contextAt(value, value.length)).toMatchObject({ kind: 'value', path: ['app', 'ea', 'wake_enabled'] })
  })

  it('walks the served schema through records and unions', () => {
    const schema = {
      properties: {
        mcp: { properties: { defaults: { additionalProperties: { type: 'boolean' } } } },
        theme: { anyOf: [{ type: 'null' }, { properties: { id: { type: 'string', description: 'Theme id' } } }] },
      },
    }
    expect(schemasAt(schema, ['mcp', 'defaults', 'github'])).toEqual([{ type: 'boolean' }])
    expect(schemasAt(schema, ['theme', 'id'])).toEqual([{ type: 'string', description: 'Theme id' }])
  })
})
