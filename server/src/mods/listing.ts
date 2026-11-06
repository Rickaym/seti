import fs from 'node:fs'
import path from 'node:path'
import { MOD_PACKAGE_LIMITS, isIconFile, modDocFiles, type ModDocs, type ModIcon, type ModManifest } from '@seti/shared'
import type { HostedMod } from './host.js'
import { modVersions } from '../store/mod-packages.js'
import { textOf } from './package/files.js'
import { iconData } from './package/icon.js'

/** The folder of the mods that ship with Seti, each in a folder named by its id. */
const BUNDLED_DIR = path.resolve(import.meta.dirname, '../../../mods')

/** Icons of stored versions by `<mod>@<hash>`: a version's files never change. */
const icons = new Map<string, ModIcon | null>()

const filesOf = async (mod: HostedMod): Promise<ReadonlyMap<string, Buffer> | null> => {
  const id = mod.manifest?.id
  const hash = mod.installed?.hash
  return id === undefined || hash === undefined ? null : ((await modVersions.get(id, hash))?.files ?? null)
}

/** An image icon from a package's files, checked as Check checked it; null when there is none. */
export function packageIcon(manifest: ModManifest, files: ReadonlyMap<string, Buffer>): ModIcon | null {
  const bytes = manifest.icon === undefined ? undefined : files.get(manifest.icon)
  if (manifest.icon === undefined || bytes === undefined) {
    return null
  }
  const checked = iconData(manifest.icon, bytes)
  return 'url' in checked ? { kind: 'image', url: checked.url } : null
}

/** The icon Settings, Mods draws for a mod: its lucide icon, its checked image, or none. */
export async function modIcon(mod: HostedMod): Promise<ModIcon | null> {
  const icon = mod.manifest?.icon
  if (mod.manifest === null || icon === undefined) {
    return null
  }
  if (!isIconFile(icon)) {
    return { kind: 'lucide', name: icon }
  }
  const key = `${mod.manifest.id}@${mod.installed?.hash ?? ''}`
  if (!icons.has(key)) {
    const files = await filesOf(mod)
    icons.set(key, files === null ? null : packageIcon(mod.manifest, files))
  }
  return icons.get(key) ?? null
}

const text = (bytes: Buffer | undefined) => (bytes === undefined ? null : textOf(bytes))

/** The README and changelog in a package's files. */
export function packageDocs(manifest: ModManifest, files: ReadonlyMap<string, Buffer>): ModDocs {
  const docs = modDocFiles(manifest)
  return { readme: text(files.get(docs.readme)), changelog: text(files.get(docs.changelog)) }
}

async function bundledDoc(id: string, file: string): Promise<string | null> {
  const bytes = await fs.promises.readFile(path.join(BUNDLED_DIR, id, file)).catch(() => null)
  return bytes === null || bytes.length > MOD_PACKAGE_LIMITS.docBytes ? null : textOf(bytes)
}

/** A mod's README and changelog: from its folder in mods/, or from its stored package. */
export async function modDocs(mod: HostedMod): Promise<ModDocs> {
  const manifest = mod.manifest
  if (manifest === null) {
    return { readme: null, changelog: null }
  }
  if (mod.tier !== 'third-party') {
    const docs = modDocFiles(manifest)
    const [readme, changelog] = await Promise.all([
      bundledDoc(manifest.id, docs.readme),
      bundledDoc(manifest.id, docs.changelog),
    ])
    return { readme, changelog }
  }
  const files = await filesOf(mod)
  return files === null ? { readme: null, changelog: null } : packageDocs(manifest, files)
}
