import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { modManifest, type ModTheme } from '@seti/shared'
import type { ThemeDefinition } from '@/components/theme/registry'
import { blocks } from '@/components/theme/theme-cascade'
import { themeOf } from './themes'

const MODS_DIR = path.resolve(import.meta.dirname, '../../../mods')
const DEFAULT_CSS = path.resolve(import.meta.dirname, '../components/theme/themes/default.css')

/** Tokens that are the same in both schemes, so dark blocks may leave them out. */
const SHARED_TOKENS = new Set(['--radius'])

/** Every colour token Seti's default theme defines, which each theme must define too. */
export function colourTokens(): string[] {
  const names = blocks(readFileSync(DEFAULT_CSS, 'utf8')).get(':root') ?? new Set<string>()
  return [...names].filter((name) => !SHARED_TOKENS.has(name)).sort((a, b) => a.localeCompare(b))
}

export interface ThemeModFile {
  mod: string
  declared: ModTheme
  definition: ThemeDefinition
  /** The token CSS as the mod's file holds it. */
  css: string
}

/** The folders in mods/ whose manifest adds a theme. */
export function themeModFolders(): string[] {
  return themeModFiles()
    .map((file) => file.mod)
    .filter((mod, i, all) => all.indexOf(mod) === i)
    .sort((a, b) => a.localeCompare(b))
}

/** Every theme the mods in mods/ declare, with its token CSS, for tests that check them all. */
export function themeModFiles(): ThemeModFile[] {
  return readdirSync(MODS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const read = (file: string) => readFileSync(path.join(MODS_DIR, entry.name, file), 'utf8')
      const manifest = modManifest.parse(JSON.parse(read('seti-mod.json')))
      return manifest.contributes.themes.map((declared) => ({
        mod: manifest.id,
        declared,
        definition: themeOf(manifest.id, declared),
        css: read(declared.tokens),
      }))
    })
    .sort((a, b) => a.definition.id.localeCompare(b.definition.id))
}
