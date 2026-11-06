import {
  consentLines,
  consentWarnings,
  modAdds,
  type ConnectionChoices,
  type ModInstallPreview,
  type ModManifest,
  type ModSourceKind,
} from '@seti/shared'
import { HttpError } from '../http.js'
import { isolation } from '../script-sandbox.js'
import { packageDocs, packageIcon } from './listing.js'
import { connectionRows, type ConnectionRow } from '../store/connections.js'
import { modFootprint, modInstalls, type ModGrantRow } from '../store/mod-packages.js'
import type { ValidPackage } from './package/validate.js'

/** Where a package came from, as the install records it and the consent screen names it. */
export interface PackageOrigin {
  kind: ModSourceKind
  /** The folder's real path, or the repository URL. */
  source: string
  /** The branch or tag a git install follows. */
  track: string | null
  /** The commit a git package was read at. */
  commit: string | null
}

/** Connections a mod can use: those that send their key in a header Seti adds. */
const usable = (row: ConnectionRow) => row.header !== null

/** The user's connections with each capability's variable, to bind one on the consent screen. */
export async function connectionChoices(): Promise<ConnectionChoices> {
  const rows = (await connectionRows.list()).filter(usable)
  return (capability) =>
    rows.filter((row) => row.env === capability.variable).map((row) => ({ id: row.id, name: row.name }))
}

/**
 * The grants of a manifest, each connection bound to a connection of the user with its variable.
 * `kept` holds bindings an earlier version had, by variable, so an update need not ask again.
 */
export async function bindGrants(
  manifest: ModManifest,
  chosen: Readonly<Record<string, string>>,
  kept: ReadonlyMap<string, string> = new Map(),
): Promise<ModGrantRow[]> {
  const rows = await connectionRows.list()
  return manifest.capabilities.map((capability, idx) => {
    if (capability.name !== 'connection') {
      return { idx, capability, connection_id: null }
    }
    const id = chosen[capability.variable] ?? kept.get(capability.variable)
    const row = rows.find((entry) => entry.id === id)
    if (id === undefined) {
      throw new HttpError(400, `Pick the ${capability.variable} connection ${manifest.name} uses`)
    }
    if (row?.env !== capability.variable) {
      throw new HttpError(409, `Add a ${capability.variable} connection in Settings, Connections first`)
    }
    if (!usable(row)) {
      throw new HttpError(409, `${row.name} sends its key in the body or URL, which mods cannot use`)
    }
    return { idx, capability, connection_id: row.id }
  })
}

/** Each connection capability's variable and the connection bound to it, from stored grants. */
export function boundByVariable(
  capabilities: readonly ModManifest['capabilities'][number][],
  connections: ReadonlyMap<number, string>,
): Map<string, string> {
  const bound = new Map<string, string>()
  capabilities.forEach((capability, idx) => {
    const id = connections.get(idx)
    if (capability.name === 'connection' && id !== undefined) {
      bound.set(capability.variable, id)
    }
  })
  return bound
}

const displayOf = (origin: PackageOrigin) =>
  origin.kind === 'git' ? `${origin.source} at ${origin.track ?? origin.commit ?? ''}` : origin.source

/** The consent screen for a package Seti read: what it is, what it may do and what it adds. */
export async function previewOf(pkg: ValidPackage, origin: PackageOrigin): Promise<ModInstallPreview> {
  const { manifest } = pkg
  const [choices, install, footprint] = await Promise.all([
    connectionChoices(),
    modInstalls.get(manifest.id),
    modFootprint(manifest.id),
  ])
  const leftover = footprint.bytes > 0 || footprint.settings > 0
  return {
    mod_id: manifest.id,
    hash: pkg.hash,
    size: pkg.size,
    manifest,
    icon: packageIcon(manifest, pkg.files),
    readme: packageDocs(manifest, pkg.files).readme,
    source: { kind: origin.kind, display: displayOf(origin), commit: origin.commit },
    capabilities: consentLines(manifest, choices),
    adds: modAdds(manifest.contributes),
    warnings: consentWarnings(manifest, isolation().isolation === 'bwrap'),
    earlier_data:
      install === undefined && leftover
        ? { source: 'an earlier install', bytes: footprint.bytes, settings: footprint.settings }
        : null,
    problem:
      install === undefined || origin.kind === 'dev'
        ? null
        : `${manifest.name} is installed already; update it from its page in Settings, Mods`,
  }
}
