import fs from 'node:fs'
import path from 'node:path'
import { modManifest, modScoped } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { MOD_ICONS } from '@/panels/settings/mods/ModGlyph'
import { MOD_STYLES, THEME_TOKENS, UI_MODS } from './bundled'
import { themeModFolders } from './theme-mod-files'

const MODS_DIR = path.resolve(import.meta.dirname, '../../../mods')

describe('the UI halves of bundled mods', () => {
  it('lists every mod folder that has a ui.tsx, and no other', () => {
    const withUi = fs
      .readdirSync(MODS_DIR)
      .filter((folder) => fs.existsSync(path.join(MODS_DIR, folder, 'ui.tsx')))
      .sort((a, b) => a.localeCompare(b))
    expect(Object.keys(UI_MODS).sort((a, b) => a.localeCompare(b))).toEqual(withUi)
  })

  it('bundles the tokens of every mod folder that adds a theme, and no other', () => {
    expect(Object.keys(THEME_TOKENS).sort((a, b) => a.localeCompare(b))).toEqual(themeModFolders())
  })

  it('bundles the stylesheet of every style a mod folder declares, and no other', () => {
    const declared = fs.readdirSync(MODS_DIR).flatMap((folder) => {
      const manifest = modManifest.parse(
        JSON.parse(fs.readFileSync(path.join(MODS_DIR, folder, 'seti-mod.json'), 'utf8')),
      )
      return manifest.contributes.styles.map((style) => {
        expect(fs.existsSync(path.join(MODS_DIR, folder, style.file)), style.file).toBe(true)
        return modScoped(manifest.id, style.id)
      })
    })
    const byName = (a: string, b: string) => a.localeCompare(b)
    expect(Object.keys(MOD_STYLES).toSorted(byName)).toEqual(declared.toSorted(byName))
  })

  it('draws the lucide icon every bundled mod names, never the fallback', () => {
    for (const folder of fs.readdirSync(MODS_DIR)) {
      const manifest = modManifest.parse(
        JSON.parse(fs.readFileSync(path.join(MODS_DIR, folder, 'seti-mod.json'), 'utf8')),
      )
      expect(Object.hasOwn(MOD_ICONS, manifest.icon ?? ''), folder).toBe(true)
    }
  })
})
