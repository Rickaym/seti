import { modCapability, type ModCapability } from '@seti/shared'
import { audit } from '../audit.js'
import type { InstalledMod } from './host.js'
import { modDevMode } from '../store/mod-lifecycle.js'
import { modLogs } from '../store/mod-logic.js'
import { modGrants, modInstalls, modVersions, type ModInstallRow } from '../store/mod-packages.js'
import { packageHash } from './package/hash.js'

export const FILES_CHANGED = 'Its files changed since you installed it'

/** The grants as stored, each parsed again so a hand-edited row cannot widen anything. */
export async function storedGrants(
  modId: string,
): Promise<{ capabilities: ModCapability[]; connections: Map<number, string> }> {
  const rows = await modGrants.of(modId)
  const capabilities = rows.flatMap((row) => {
    const parsed = modCapability.safeParse(row.capability)
    return parsed.success ? [parsed.data] : []
  })
  const connections = new Map(rows.flatMap((row) => (row.connection_id === null ? [] : [[row.idx, row.connection_id]])))
  return { capabilities, connections }
}

/**
 * Why a third-party mod must not start: its stored files no longer hash to the version the user
 * approved. Seti never reloads quietly; it keeps the mod off, logs it and audits it.
 */
export async function pinProblem(modId: string, hash: string): Promise<string | null> {
  const [install, version] = await Promise.all([modInstalls.get(modId), modVersions.get(modId, hash)])
  if (install?.current_hash === hash && version !== undefined && packageHash(version.files) === hash) {
    return null
  }
  await modLogs.system(modId, `Seti kept it off: ${FILES_CHANGED.toLowerCase()}`, 'error')
  await audit.record({
    actor: 'system',
    kind: 'mod.files_changed',
    subject_type: 'mod',
    subject_id: modId,
    summary: `Kept the ${modId} mod off: its files no longer match the version you installed`,
    detail: { mod: modId, hash },
  })
  return FILES_CHANGED
}

export async function installedMod(row: ModInstallRow): Promise<InstalledMod | null> {
  const version = await modVersions.get(row.mod_id, row.current_hash)
  if (version === undefined) {
    return null
  }
  const { capabilities } = await storedGrants(row.mod_id)
  return {
    manifest: version.manifest,
    installed: { hash: row.current_hash, grants: capabilities, dev: row.source_kind === 'dev' },
  }
}

/** Every installed third-party mod to host; dev mods only while Developer mode is on. */
export async function installedMods(): Promise<InstalledMod[]> {
  const devMode = await modDevMode.get()
  const rows = (await modInstalls.all()).filter((row) => devMode || row.source_kind !== 'dev')
  const found = await Promise.all(rows.map(installedMod))
  return found.filter((entry) => entry !== null)
}
