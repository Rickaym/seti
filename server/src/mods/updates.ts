import {
  consentLines,
  diffCapabilities,
  diffChanges,
  modManifest,
  shortModHash,
  type ModInstallInfo,
  type ModManifest,
  type ModPendingUpdate,
  type ModUpdateApplyInput,
} from '@seti/shared'
import { audit } from '../audit.js'
import { inBackground } from '../background.js'
import { HttpError } from '../http.js'
import { pushToEveryDevice } from '../notifications.js'
import { modHost } from './bundled.js'
import { requireUserConsent } from './consent-guard.js'
import { boundByVariable, connectionChoices } from './consent.js'
import {
  checkedVersion,
  hostInstalled,
  installedVersion,
  pruneVersions,
  regrant,
  stageVersion,
  versionDetail,
} from './install.js'
import { storedGrants } from './installed.js'
import { modLogs } from '../store/mod-logic.js'
import { modFootprint, modInstalls, modVersions, switchVersion, type ModInstallRow } from '../store/mod-packages.js'
import { readOrigin } from './package/read.js'
import type { ValidPackage } from './package/validate.js'

const HOUR_MS = 3_600_000

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  const d = (x ?? []).map((n, i) => n - (y?.[i] ?? 0)).find((n) => n !== 0) ?? 0
  return d > 0
}

/** What a staged version changes against what the mod holds now, in Seti's words. */
async function changesOf(modId: string, next: ModManifest): Promise<{ changes: string[]; widens: boolean }> {
  const { capabilities } = await storedGrants(modId)
  const contributes = modHost.get(modId)?.manifest?.contributes ?? next.contributes
  const diff = diffCapabilities({ capabilities, contributes }, next)
  return { changes: diffChanges(diff), widens: diff.added.length + diff.widened.length > 0 }
}

async function notifyUpdate(title: string, body: string, modId: string): Promise<void> {
  await pushToEveryDevice({
    title,
    body,
    tag: `mod-update-${modId}`,
    url: `/#settings/mods/${modId}`,
    kind: 'mod_update',
  })
}

/** Stages a version Seti read for an installed mod: consent when it reaches further, else a delay. */
export async function stageUpdate(row: ModInstallRow, pkg: ValidPackage, actor: 'user' | 'system'): Promise<string> {
  const dev = row.source_kind === 'dev'
  const name = pkg.manifest.name
  if (pkg.manifest.id !== row.mod_id) {
    throw new HttpError(409, `The package now has the id ${pkg.manifest.id}, not ${row.mod_id}`)
  }
  if (pkg.hash === row.current_hash || pkg.hash === row.pending_hash) {
    return pkg.hash === row.current_hash
      ? `${name} is up to date`
      : `${name} ${pkg.manifest.version} is waiting already`
  }
  await stageVersion(pkg, { kind: row.source_kind, source: row.source, track: row.track, commit: null })
  const { widens } = await changesOf(row.mod_id, pkg.manifest)
  await modInstalls.setPending(row.mod_id, pkg.hash, widens ? 'consent' : 'delay')
  await pruneVersions(row.mod_id)
  await audit.record({
    actor,
    kind: 'mod.update_pending',
    subject_type: 'mod',
    subject_id: row.mod_id,
    summary: `${name} ${pkg.manifest.version} is ready and ${widens ? 'waits for your consent' : 'applies after its delay'}`,
    detail: { ...versionDetail(pkg.manifest, pkg.hash), reason: widens ? 'consent' : 'delay' },
  })
  if (widens || !dev) {
    await notifyUpdate(
      `${name} ${pkg.manifest.version} is ready`,
      widens ? 'It asks for more; review it in Settings, Mods' : 'It applies on its own after its delay',
      row.mod_id,
    )
  }
  if (dev && !widens) {
    await applyVersion(row, pkg.hash, {}, 'user')
    return `Reloaded ${name} (dev)`
  }
  return widens
    ? `${name} ${pkg.manifest.version} asks for more and waits for you`
    : `${name} ${pkg.manifest.version} is staged`
}

/** Reads the install's source again and stages what changed; runs none of the mod's code. */
export async function checkForUpdate(modId: string): Promise<string> {
  await requireUserConsent({ stepUp: false })
  const { install } = await installedVersion(modId)
  if (install.source_kind === 'dev') {
    throw new HttpError(409, 'A dev mod reloads from its folder on every change')
  }
  const origin = { kind: install.source_kind, source: install.source, track: install.track, commit: null }
  const { pkg } = await readOrigin(origin, modHost.bundledIds)
  return stageUpdate(install, pkg, 'user')
}

/** Switches to a staged version and tells every device, so no update is silent; dev reloads aside. */
async function applyVersion(
  row: ModInstallRow,
  hash: string,
  chosen: Record<string, string>,
  actor: 'user' | 'system',
) {
  const { manifest } = await checkedVersion(row.mod_id, hash)
  const { grants } = await regrant(manifest, chosen)
  await switchVersion(row.mod_id, hash, grants)
  await pruneVersions(row.mod_id)
  await hostInstalled(row.mod_id)
  await audit.record({
    actor,
    kind: 'mod.updated',
    subject_type: 'mod',
    subject_id: row.mod_id,
    summary: `Updated the ${manifest.name} mod to ${manifest.version} (${shortModHash(hash)})`,
    detail: { ...versionDetail(manifest, hash), from: row.current_hash },
  })
  if (row.source_kind !== 'dev') {
    await notifyUpdate(
      `${manifest.name} updated to ${manifest.version}`,
      'Roll it back from Settings, Mods',
      row.mod_id,
    )
  }
}

/** Applies the pending version now; one that reaches further needs the user's consent and step-up. */
export async function applyUpdate(modId: string, input: ModUpdateApplyInput): Promise<void> {
  await requireUserConsent({ stepUp: false })
  const { install } = await installedVersion(modId)
  if (install.pending_hash !== input.hash) {
    throw new HttpError(409, 'That update is no longer pending')
  }
  const { manifest } = await checkedVersion(modId, input.hash)
  const { widens } = await changesOf(modId, manifest)
  if (widens || install.pending_reason === 'consent') {
    await requireUserConsent({ stepUp: true })
  }
  await applyVersion(install, input.hash, input.connections ?? {}, 'user')
}

export async function skipUpdate(modId: string, hash: string): Promise<void> {
  await requireUserConsent({ stepUp: false })
  const { install, manifest } = await installedVersion(modId)
  if (install.pending_hash !== hash) {
    throw new HttpError(409, 'That update is no longer pending')
  }
  await modInstalls.clearPending(modId)
  await pruneVersions(modId)
  await modLogs.system(modId, `You skipped the update ${shortModHash(hash)}`)
  await audit.record({
    actor: 'user',
    kind: 'mod.update_pending',
    subject_type: 'mod',
    subject_id: modId,
    summary: `Skipped an update of the ${manifest?.name ?? modId} mod`,
    detail: { mod: modId, hash, skipped: true },
  })
}

/** Applies every delayed update whose time came; widening updates never apply on their own. */
export async function applyDueUpdates(at: Date = new Date()): Promise<void> {
  for (const row of await modInstalls.due(at)) {
    if (row.pending_hash === null) {
      continue
    }
    const { manifest } = await checkedVersion(row.mod_id, row.pending_hash)
    if ((await changesOf(row.mod_id, manifest)).widens) {
      await modInstalls.setPending(row.mod_id, row.pending_hash, 'consent')
      continue
    }
    await applyVersion(row, row.pending_hash, {}, 'system')
  }
}

/** The pending update of an install, as its card shows it. */
async function pendingOf(row: ModInstallRow, current: string): Promise<ModPendingUpdate | null> {
  if (row.pending_hash === null || row.pending_reason === null || row.pending_since === null) {
    return null
  }
  const version = await modVersions.get(row.mod_id, row.pending_hash)
  const manifest = modManifest.safeParse(version?.manifest)
  if (!manifest.success) {
    return null
  }
  const [{ changes }, granted, choices] = await Promise.all([
    changesOf(row.mod_id, manifest.data),
    storedGrants(row.mod_id),
    connectionChoices(),
  ])
  const bound = new Set(boundByVariable(granted.capabilities, granted.connections).keys())
  return {
    hash: row.pending_hash,
    version: manifest.data.version,
    reason: row.pending_reason,
    since: row.pending_since,
    applies_at:
      row.pending_reason === 'delay'
        ? new Date(Date.parse(row.pending_since) + row.update_delay_hours * HOUR_MS).toISOString()
        : null,
    changes,
    bindings: consentLines(manifest.data, choices).filter(
      (line) => line.capability.name === 'connection' && !bound.has(line.capability.variable),
    ),
    older: newer(current, manifest.data.version),
  }
}

/** How a third-party mod was installed, its pending update and kept versions, for its card. */
export async function installInfo(modId: string, current: string): Promise<ModInstallInfo | null> {
  const row = await modInstalls.get(modId)
  if (row === undefined) {
    return null
  }
  const [versions, lastError, footprint, pending] = await Promise.all([
    modVersions.list(modId),
    modLogs.lastError(modId),
    modFootprint(modId),
    pendingOf(row, current),
  ])
  return {
    source_kind: row.source_kind,
    source: row.source,
    track: row.track,
    hash: row.current_hash,
    update_delay_hours: row.update_delay_hours,
    pending,
    versions: versions
      .filter((version) => version.hash !== row.current_hash && version.hash !== row.pending_hash)
      .map((version) => ({ hash: version.hash, version: version.version, fetched_at: version.fetched_at })),
    last_error: lastError,
    data_bytes: footprint.bytes,
    settings_count: footprint.settings,
  }
}

const TICK_MS = 10 * 60_000
const CHECK_MS = 24 * HOUR_MS
let lastCheck = 0

/** Checks git installs once a day and applies delayed updates whose time came. */
export function startModUpdates(): void {
  setInterval(() => {
    inBackground('mod updates', async () => {
      await applyDueUpdates()
      if (Date.now() - lastCheck < CHECK_MS) {
        return
      }
      lastCheck = Date.now()
      for (const row of (await modInstalls.all()).filter((entry) => entry.source_kind === 'git')) {
        const origin = { kind: row.source_kind, source: row.source, track: row.track, commit: null }
        await readOrigin(origin, modHost.bundledIds)
          .then(async ({ pkg }) => stageUpdate(row, pkg, 'system'))
          .catch(async (e: unknown) => modLogs.system(row.mod_id, `Update check failed: ${String(e)}`, 'warn'))
      }
    })
  }, TICK_MS).unref()
}
