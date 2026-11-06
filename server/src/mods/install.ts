import {
  MOD_PACKAGE_LIMITS,
  diffCapabilities,
  manifestProblem,
  modManifest,
  needsConsent,
  shortModHash,
  type ModInstallInput,
  type ModInstallPreview,
  type ModManifest,
  type ModSourceInput,
} from '@seti/shared'
import { audit } from '../audit.js'
import { HttpError } from '../http.js'
import { modHost } from './bundled.js'
import { requireUserConsent } from './consent-guard.js'
import { bindGrants, boundByVariable, previewOf, type PackageOrigin } from './consent.js'
import { isRequired, requiredReason } from './host.js'
import { installedMod, storedGrants } from './installed.js'
import { modDevMode } from '../store/mod-lifecycle.js'
import {
  modInstalls,
  modVersions,
  removeInstall,
  switchVersion,
  writeInstall,
  type ModGrantRow,
  type StoredVersion,
} from '../store/mod-packages.js'
import { packageHash } from './package/hash.js'
import { readFrom } from './package/read.js'
import type { ValidPackage } from './package/validate.js'

/** Where each previewed package came from, until the user installs it or it ages out. */
const staged = new Map<string, { origin: PackageOrigin; at: number }>()
const STAGED_MS = 60 * 60_000

const stagedKey = (modId: string, hash: string) => `${modId}@${hash}`

export function rememberOrigin(modId: string, hash: string, origin: PackageOrigin): void {
  const cutoff = Date.now() - STAGED_MS
  for (const [key, entry] of staged) {
    if (entry.at < cutoff) {
      staged.delete(key)
    }
  }
  staged.set(stagedKey(modId, hash), { origin, at: Date.now() })
}

export async function requireDevMode(): Promise<void> {
  if (!(await modDevMode.get())) {
    throw new HttpError(409, 'Turn on Developer mode in Settings, Mods')
  }
}

/** Keeps a checked package as a version of the mod, so install, update and rollback can use it. */
export async function stageVersion(pkg: ValidPackage, origin: PackageOrigin): Promise<void> {
  await modVersions.stage({
    modId: pkg.manifest.id,
    hash: pkg.hash,
    version: pkg.manifest.version,
    manifest: pkg.manifest,
    files: pkg.files,
    scriptHashes: pkg.scriptHashes,
    size: pkg.size,
    sourceRef: origin.commit ?? origin.source,
  })
}

/** Keeps the running and pending versions and the two newest others; drops the rest. */
export async function pruneVersions(modId: string): Promise<void> {
  const install = await modInstalls.get(modId)
  const pinned = [install?.current_hash, install?.pending_hash].filter(
    (hash): hash is string => typeof hash === 'string',
  )
  const others = (await modVersions.list(modId)).filter((row) => !pinned.includes(row.hash))
  const kept = install?.source_kind === 'dev' ? 0 : MOD_PACKAGE_LIMITS.previousKept
  await modVersions.prune(modId, [...pinned, ...others.slice(0, kept).map((row) => row.hash)])
}

/** A stored version, checked again against its hash and against the manifest rules of now. */
export async function checkedVersion(
  modId: string,
  hash: string,
): Promise<{ version: StoredVersion; manifest: ModManifest }> {
  const version = await modVersions.get(modId, hash)
  if (version === undefined) {
    throw new HttpError(404, 'Seti no longer has that version; check the package again')
  }
  if (packageHash(version.files) !== hash) {
    throw new HttpError(409, 'Its files changed since Seti checked them; check the package again')
  }
  const manifest = modManifest.parse(version.manifest)
  const problem = manifestProblem(manifest, 'third-party', modHost.bundledIds)
  if (problem !== null) {
    throw new HttpError(409, problem)
  }
  return { version, manifest }
}

/** Starts the version that is now current in the host, so it runs with its new grants. */
export async function hostInstalled(modId: string): Promise<void> {
  const row = await modInstalls.get(modId)
  const entry = row === undefined ? null : await installedMod(row)
  if (entry !== null) {
    await modHost.adopt(entry)
  }
}

const hostsOf = (manifest: ModManifest) => [
  ...new Set(manifest.capabilities.flatMap((capability) => ('hosts' in capability ? capability.hosts : []))),
]

const connectionNames = (manifest: ModManifest) =>
  manifest.capabilities.flatMap((capability) => (capability.name === 'connection' ? [capability.variable] : []))

/** The audit detail of a version: hashes, hosts, capability and connection names; never values. */
export const versionDetail = (manifest: ModManifest, hash: string) => ({
  mod: manifest.id,
  version: manifest.version,
  hash,
  capabilities: manifest.capabilities.map((capability) => capability.name),
  hosts: hostsOf(manifest),
  connections: connectionNames(manifest),
})

/** Reads a package and shows what installing it means; nothing runs and nothing is granted. */
export async function previewInstall(source: ModSourceInput): Promise<ModInstallPreview> {
  await requireUserConsent({ stepUp: false })
  await requireDevMode()
  const { pkg, origin } = await readFrom(source, modHost.bundledIds)
  const preview = await previewOf(pkg, origin)
  if (preview.problem === null) {
    await stageVersion(pkg, origin)
    rememberOrigin(pkg.manifest.id, pkg.hash, origin)
  }
  return preview
}

/** Installs a previewed package with the connections the user picked, and turns it on. */
export async function installMod(input: ModInstallInput): Promise<void> {
  await requireUserConsent({ stepUp: true })
  await requireDevMode()
  const origin = staged.get(stagedKey(input.mod_id, input.hash))?.origin
  if (origin === undefined) {
    throw new HttpError(404, 'Check the package again before installing it')
  }
  if ((await modInstalls.get(input.mod_id)) !== undefined && origin.kind !== 'dev') {
    throw new HttpError(409, 'It is installed already; update it from its page in Settings, Mods')
  }
  const { manifest } = await checkedVersion(input.mod_id, input.hash)
  const grants = await bindGrants(manifest, input.connections ?? {})
  if (input.delete_earlier_data === true && (await modInstalls.get(manifest.id)) === undefined) {
    await removeInstall(manifest.id, true)
  }
  await writeInstall({
    modId: manifest.id,
    kind: origin.kind,
    source: origin.source,
    track: origin.track,
    hash: input.hash,
    grants,
  })
  staged.delete(stagedKey(input.mod_id, input.hash))
  await pruneVersions(manifest.id)
  await hostInstalled(manifest.id)
  await audit.record({
    actor: 'user',
    kind: 'mod.installed',
    subject_type: 'mod',
    subject_id: manifest.id,
    summary: `Installed the ${manifest.name} mod ${manifest.version} (${shortModHash(input.hash)}) and turned it on`,
    detail: { ...versionDetail(manifest, input.hash), source: origin.source, source_kind: origin.kind },
  })
}

/** The installed mod and the manifest of the version that runs, or a 404. */
export async function installedVersion(modId: string) {
  const install = await modInstalls.get(modId)
  if (install === undefined) {
    throw new HttpError(404, `Seti has no installed mod ${modId}`)
  }
  const version = await modVersions.get(modId, install.current_hash)
  const manifest = modManifest.safeParse(version?.manifest)
  return { install, manifest: manifest.success ? manifest.data : null }
}

/** The grants a version gets when it replaces the running one, keeping connection bindings. */
export async function regrant(
  manifest: ModManifest,
  chosen: Readonly<Record<string, string>> = {},
): Promise<{ grants: ModGrantRow[]; widens: boolean }> {
  const { capabilities, connections } = await storedGrants(manifest.id)
  const current = modHost.get(manifest.id)?.manifest?.contributes ?? manifest.contributes
  const widens = needsConsent(diffCapabilities({ capabilities, contributes: current }, manifest))
  const grants = await bindGrants(manifest, chosen, boundByVariable(capabilities, connections))
  return { grants, widens }
}

/** Rolls back to a kept version; one that would reach further needs the same consent as install. */
export async function rollbackMod(modId: string, hash: string): Promise<void> {
  await requireUserConsent({ stepUp: false })
  const { install } = await installedVersion(modId)
  if (install.current_hash === hash) {
    throw new HttpError(409, 'That version runs already')
  }
  const { manifest } = await checkedVersion(modId, hash)
  const { grants, widens } = await regrant(manifest)
  if (widens) {
    await requireUserConsent({ stepUp: true })
  }
  await switchVersion(modId, hash, grants)
  await pruneVersions(modId)
  await hostInstalled(modId)
  await audit.record({
    actor: 'user',
    kind: 'mod.rolled_back',
    subject_type: 'mod',
    subject_id: modId,
    summary: `Rolled the ${manifest.name} mod back to ${manifest.version} (${shortModHash(hash)})`,
    detail: { ...versionDetail(manifest, hash), from: install.current_hash, widened: widens },
  })
}

/** Removes a third-party mod and its versions; its data and settings go too when asked. */
export async function uninstallMod(modId: string, deleteData: boolean): Promise<void> {
  await requireUserConsent({ stepUp: true })
  const hosted = modHost.get(modId)
  if (hosted !== undefined && isRequired(hosted)) {
    throw new HttpError(409, requiredReason(hosted))
  }
  const { manifest } = await installedVersion(modId)
  modHost.drop(modId)
  await removeInstall(modId, deleteData)
  await audit.record({
    actor: 'user',
    kind: 'mod.uninstalled',
    subject_type: 'mod',
    subject_id: modId,
    summary: `Uninstalled the ${manifest?.name ?? modId} mod${deleteData ? ' and deleted its data' : ''}`,
    detail: { mod: modId, data_deleted: deleteData },
  })
}
