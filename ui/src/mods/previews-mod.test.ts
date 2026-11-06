import previews from '@seti/mod-previews/seti-mod.json' with { type: 'json' }
import { modManifest, modSwitches, type ModInfo } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { modShowing, viewerFor } from '@/panels/files/file-viewers'

const manifest = modManifest.parse(previews)
const info: ModInfo = {
  id: 'previews',
  name: 'Previews',
  display_name: 'Previews',
  icon: { kind: 'lucide', name: 'eye' },
  version: manifest.version,
  description: manifest.description,
  author: null,
  tier: 'bundled',
  enabled: true,
  running: true,
  security_sensitive: false,
  required: false,
  restart: false,
  capabilities: [],
  points: [],
  problem: null,
  held_by_safe_mode: false,
  notifications: [],
  settings: [],
  off_switches: [],
  manifest,
  install: null,
}

const FILES = {
  pdf: { name: 'report.pdf', kind: 'pdf', size: 10 },
  sheets: { name: 'people.csv', kind: 'csv', size: 10 },
  workbook: { name: 'budget.xlsx', kind: 'spreadsheet', size: 10 },
  mermaid: { name: 'flow.mmd', kind: 'mermaid', size: 10 },
} as const

describe('the Previews mod', () => {
  it('is required, an ordinary bundled mod otherwise, with a switch per format that starts on', () => {
    expect(manifest.required).toBe(true)
    expect(manifest.securitySensitive).toBe(false)
    expect(modSwitches(manifest.contributes)).toEqual(['pdf', 'sheets', 'mermaid'])
    for (const key of modSwitches(manifest.contributes)) {
      expect(manifest.contributes.settings[key]).toMatchObject({ type: 'boolean', default: true })
    }
    expect(manifest.contributes.fenceRenderers).toEqual([{ language: 'mermaid', setting: 'mermaid' }])
  })

  it('names itself while off, and the format switch while only that format is off', () => {
    expect(viewerFor(FILES.pdf, false)).toBeUndefined()
    expect(modShowing([info], FILES.pdf)).toBeUndefined()
    expect(modShowing([{ ...info, enabled: false }], FILES.mermaid)).toEqual({
      mod: { ...info, enabled: false },
      setting: null,
    })
    const sheetsOff = { ...info, off_switches: ['sheets'] }
    expect(modShowing([sheetsOff], FILES.sheets)?.setting).toBe('sheets')
    expect(modShowing([sheetsOff], FILES.workbook)?.setting).toBe('sheets')
    expect(modShowing([sheetsOff], FILES.pdf)).toBeUndefined()
    expect(modShowing([sheetsOff], FILES.mermaid)).toBeUndefined()
  })
})
