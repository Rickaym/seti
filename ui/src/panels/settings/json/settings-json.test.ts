import { SETTINGS_SECTIONS, type SettingsDoc } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { settingsPages } from '../pages'
import { docSections, exportName, pruned, shownSections } from './settings-json'

/**
 * Pages that hold no setting of Seti's own, each with why. A new settings page fails the parity
 * test below until it is a section's page in shared/src/settings-doc-*.ts or is listed here.
 */
const NO_SETTINGS: Record<string, string> = {
  about: "what's new and the version",
  skills: "Claude Code's skill files, read by the probe",
  tools: 'scripts agents proposed and the user published, not settings',
  audit: 'a log, not settings',
  json: 'this view of the document itself',
  mods: 'each mod is its own section under mods',
}

const DOC = {
  version: 1,
  revision: 'r',
  app: { ea: { wake_enabled: true, wake_phrase: 'Hey Seti' } },
  security: { sandbox: { enabled: true, allowed_domains: ['registry.npmjs.org'] } },
  mods: { weather: { enabled: true, settings: { units: 'metric' } } },
} satisfies SettingsDoc

describe('the settings JSON page', () => {
  it('lists a section for every settings page that holds settings', () => {
    const pages = new Set(Object.values(SETTINGS_SECTIONS).map((section) => section.page))
    const missing = settingsPages
      .list()
      .map((page) => page.key)
      .filter((key) => !pages.has(key) && !(key in NO_SETTINGS))
    expect(missing, 'give each page a section in the settings document, or list it in NO_SETTINGS').toEqual([])
    const unknown = [...pages].filter((key) => !settingsPages.has(key))
    expect(unknown, 'sections whose page is not a settings page').toEqual([])
  })

  it('splits the document into sections, mods one each', () => {
    expect(docSections(DOC).map((section) => section.path)).toEqual(['app.ea', 'security.sandbox', 'mods.weather'])
  })

  it('keeps only what matches a search, by key or value', () => {
    expect(pruned(DOC.app.ea, 'phrase', 'app.ea')).toEqual({ wake_phrase: 'Hey Seti' })
    expect(pruned(DOC.security.sandbox, 'npmjs', 'security.sandbox')).toEqual({
      allowed_domains: ['registry.npmjs.org'],
    })
    expect(pruned(DOC.app.ea, 'nothing', 'app.ea')).toBeUndefined()
    expect(shownSections(docSections(DOC), 'Sandbox', null).map((section) => section.path)).toEqual([
      'security.sandbox',
    ])
    expect(shownSections(docSections(DOC), '', 'mods').map((section) => section.path)).toEqual(['mods.weather'])
  })

  it('dates the export', () => {
    expect(exportName(new Date('2026-11-24T12:00:00Z'))).toBe('seti-settings-2026-11-24.json')
  })
})
