import fs from 'node:fs'
import path from 'node:path'
import { isIconFile, manifestProblem, modManifest, type ModTier } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BUNDLED_MODS, TEST_MODS, THEME_MODS } from './bundled.js'

const MODS_DIR = path.resolve(import.meta.dirname, '../../../mods')

const modPackage = z.object({ scripts: z.record(z.string(), z.string()).optional() })

const folders = fs
  .readdirSync(MODS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b))

const idOf = (manifest: unknown) => modManifest.parse(manifest).id

const tierOf = new Map<string, ModTier>(THEME_MODS.map((definition) => [idOf(definition.manifest), 'theme']))

describe('the bundled mods', () => {
  it('registers every folder in mods/ exactly once, by the id its folder is named after', () => {
    const listed = [...BUNDLED_MODS, ...THEME_MODS, ...TEST_MODS]
      .map((definition) => idOf(definition.manifest))
      .sort((a, b) => a.localeCompare(b))
    expect(listed).toEqual(folders)
  })

  it('ship valid manifests that this Seti can run, in packages named after the mod', () => {
    for (const folder of folders) {
      const read = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(MODS_DIR, folder, file), 'utf8'))
      const manifest = modManifest.parse(read('seti-mod.json'))
      expect(manifest.id, folder).toBe(folder)
      expect(manifestProblem(manifest, tierOf.get(folder) ?? 'bundled'), folder).toBeNull()
      expect(read('package.json'), folder).toMatchObject({ name: `@seti/mod-${folder}` })
    }
  })

  it('present themselves in Settings, Mods: a lucide icon, categories, a README and a changelog', () => {
    for (const folder of folders) {
      const manifest = modManifest.parse(
        JSON.parse(fs.readFileSync(path.join(MODS_DIR, folder, 'seti-mod.json'), 'utf8')),
      )
      expect(manifest.icon !== undefined && !isIconFile(manifest.icon), folder).toBe(true)
      expect(manifest.categories.length, folder).toBeGreaterThan(0)
      expect(manifest.author, folder).toBe('Seti')
      for (const doc of ['README.md', 'CHANGELOG.md']) {
        const text = fs.readFileSync(path.join(MODS_DIR, folder, doc), 'utf8')
        expect(text.startsWith('# '), `${folder}/${doc}`).toBe(true)
      }
    }
  })

  it('run their tests with the shared mod test config, so parallel runs keep separate caches', () => {
    const config = "import { modTestConfig } from '@seti/mod-api/vitest'\n\nexport default modTestConfig\n"
    for (const folder of folders) {
      const pkg = modPackage.parse(JSON.parse(fs.readFileSync(path.join(MODS_DIR, folder, 'package.json'), 'utf8')))
      const file = path.join(MODS_DIR, folder, 'vitest.config.ts')
      const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
      expect(actual, folder).toBe(pkg.scripts?.test === undefined ? null : config)
    }
  })
})
