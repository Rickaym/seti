import { gunzipSync, gzipSync } from 'node:zlib'
import type { ModSourceKind, ModUpdateReason } from '@seti/shared'
import { now, sql, transaction, type Db } from '../db.js'

/** How a third-party mod was installed and which version runs, as mod_install holds it. */
export interface ModInstallRow {
  mod_id: string
  source_kind: ModSourceKind
  source: string
  track: string | null
  current_hash: string
  pending_hash: string | null
  pending_reason: ModUpdateReason | null
  pending_since: string | null
  update_delay_hours: number
  installed_at: string
  updated_at: string
}

/** A kept version without its files, for lists. */
export interface ModVersionRow {
  mod_id: string
  hash: string
  version: string
  manifest: unknown
  size: number
  source_ref: string | null
  fetched_at: string
}

/** A kept version with its files, as Seti verifies and serves it. */
export interface StoredVersion extends ModVersionRow {
  files: Map<string, Buffer>
  script_hashes: Record<string, string[]>
}

export interface NewVersion {
  modId: string
  hash: string
  version: string
  manifest: unknown
  files: ReadonlyMap<string, Buffer>
  scriptHashes: Record<string, string[]>
  size: number
  sourceRef: string | null
}

/** One granted capability of an installed version and the connection the user bound to it. */
export interface ModGrantRow {
  idx: number
  capability: unknown
  connection_id: string | null
}

const json = (value: unknown) => JSON.stringify(value)

/** Files as one gzipped JSON map of path to base64, so a version is a single column. */
export const encodeFiles = (files: ReadonlyMap<string, Buffer>): Buffer =>
  gzipSync(json(Object.fromEntries([...files].map(([file, bytes]) => [file, bytes.toString('base64')]))))

function decodeFiles(stored: Buffer): Map<string, Buffer> {
  const map = JSON.parse(gunzipSync(stored).toString('utf8')) as Record<string, string>
  return new Map(Object.entries(map).map(([file, text]) => [file, Buffer.from(text, 'base64')]))
}

const VERSION_COLUMNS = sql`mod_id, hash, version, manifest, size, source_ref, fetched_at`

export const modVersions = {
  /** Keeps a version Seti read and checked; the same hash is the same files, so it is kept once. */
  stage: async (version: NewVersion): Promise<void> => {
    await sql`INSERT INTO mod_version (mod_id, hash, version, manifest, files, script_hashes, size, source_ref,
        fetched_at)
      VALUES (${version.modId}, ${version.hash}, ${version.version}, ${json(version.manifest)}::text::jsonb,
        ${encodeFiles(version.files)}, ${json(version.scriptHashes)}::text::jsonb, ${version.size},
        ${version.sourceRef}, ${now()})
      ON CONFLICT (mod_id, hash) DO UPDATE SET fetched_at = excluded.fetched_at`
  },
  get: async (modId: string, hash: string): Promise<StoredVersion | undefined> => {
    const [row] = await sql<(ModVersionRow & { files: Buffer; script_hashes: Record<string, string[]> })[]>`
      SELECT ${VERSION_COLUMNS}, files, script_hashes FROM mod_version WHERE mod_id = ${modId} AND hash = ${hash}`
    return row === undefined ? undefined : { ...row, files: decodeFiles(row.files) }
  },
  list: async (modId: string): Promise<ModVersionRow[]> =>
    sql<ModVersionRow[]>`SELECT ${VERSION_COLUMNS} FROM mod_version WHERE mod_id = ${modId}
      ORDER BY fetched_at DESC, hash`,
  /** Drops every version of the mod but those kept. */
  prune: async (modId: string, keep: readonly string[]): Promise<void> => {
    await sql`DELETE FROM mod_version WHERE mod_id = ${modId} AND NOT (hash = ANY(${[...keep]}::text[]))`
  },
}

export const modInstalls = {
  all: async (): Promise<ModInstallRow[]> => sql<ModInstallRow[]>`SELECT * FROM mod_install ORDER BY mod_id`,
  get: async (modId: string): Promise<ModInstallRow | undefined> =>
    (await sql<ModInstallRow[]>`SELECT * FROM mod_install WHERE mod_id = ${modId}`).at(0),
  setPending: async (modId: string, hash: string, reason: ModUpdateReason): Promise<void> => {
    await sql`UPDATE mod_install SET pending_hash = ${hash}, pending_reason = ${reason}, pending_since = ${now()},
      updated_at = ${now()} WHERE mod_id = ${modId}`
  },
  clearPending: async (modId: string): Promise<void> => {
    await sql`UPDATE mod_install SET pending_hash = NULL, pending_reason = NULL, pending_since = NULL,
      updated_at = ${now()} WHERE mod_id = ${modId}`
  },
  change: async (modId: string, delayHours: number, track: string | null): Promise<void> => {
    await sql`UPDATE mod_install SET update_delay_hours = ${delayHours}, track = ${track}, updated_at = ${now()}
      WHERE mod_id = ${modId}`
  },
  /** Pending updates whose delay has run out. */
  due: async (at: Date = new Date()): Promise<ModInstallRow[]> =>
    (await sql<ModInstallRow[]>`SELECT * FROM mod_install WHERE pending_reason = 'delay'`).filter(
      (row) => Date.parse(row.pending_since ?? '') + row.update_delay_hours * 3_600_000 <= at.getTime(),
    ),
}

async function putGrants(tx: Db, modId: string, hash: string, grants: readonly ModGrantRow[]): Promise<void> {
  await tx`DELETE FROM mod_grant WHERE mod_id = ${modId}`
  for (const grant of grants) {
    await tx`INSERT INTO mod_grant (mod_id, hash, idx, capability, connection_id, granted_at)
      VALUES (${modId}, ${hash}, ${grant.idx}, ${json(grant.capability)}::text::jsonb, ${grant.connection_id}, ${now()})`
  }
}

export const modGrants = {
  of: async (modId: string): Promise<(ModGrantRow & { hash: string })[]> =>
    sql<(ModGrantRow & { hash: string })[]>`SELECT hash, idx, capability, connection_id FROM mod_grant
      WHERE mod_id = ${modId} ORDER BY idx`,
}

/** What a new install writes: where it came from, the version that runs and what the user granted. */
export interface InstallWrite {
  modId: string
  kind: ModSourceKind
  source: string
  track: string | null
  hash: string
  grants: readonly ModGrantRow[]
}

/** Installs, or reinstalls over an earlier install of the same id, and turns the mod on. */
export async function writeInstall(write: InstallWrite): Promise<void> {
  const at = now()
  await transaction(async (tx) => {
    await tx`INSERT INTO mod_install (mod_id, source_kind, source, track, current_hash, installed_at, updated_at)
      VALUES (${write.modId}, ${write.kind}, ${write.source}, ${write.track}, ${write.hash}, ${at}, ${at})
      ON CONFLICT (mod_id) DO UPDATE SET source_kind = excluded.source_kind, source = excluded.source,
        track = excluded.track, current_hash = excluded.current_hash, pending_hash = NULL, pending_reason = NULL,
        pending_since = NULL, updated_at = excluded.updated_at`
    await putGrants(tx, write.modId, write.hash, write.grants)
    await tx`INSERT INTO mod_state (mod_id, enabled, updated_at) VALUES (${write.modId}, true, ${at})
      ON CONFLICT (mod_id) DO UPDATE SET enabled = true, updated_at = excluded.updated_at`
  })
}

/** Makes `hash` the running version with its grants, clearing any pending update. */
export async function switchVersion(modId: string, hash: string, grants: readonly ModGrantRow[]): Promise<void> {
  await transaction(async (tx) => {
    await tx`UPDATE mod_install SET current_hash = ${hash}, pending_hash = NULL, pending_reason = NULL,
      pending_since = NULL, updated_at = ${now()} WHERE mod_id = ${modId}`
    await putGrants(tx, modId, hash, grants)
  })
}

/** Removes the install and its versions; with deleteData, every row the mod left in Seti too. */
export async function removeInstall(modId: string, deleteData: boolean): Promise<void> {
  await transaction(async (tx) => {
    for (const table of ['mod_install', 'mod_version', 'mod_grant', 'mod_log', 'mod_usage'] as const) {
      await tx`DELETE FROM ${tx(table)} WHERE mod_id = ${modId}`
    }
    await tx`DELETE FROM mod_ask WHERE mod_id = ${modId} AND decision IS NULL`
    if (deleteData) {
      for (const table of ['mod_data', 'mod_settings', 'mod_notification', 'mod_state', 'mod_ask'] as const) {
        await tx`DELETE FROM ${tx(table)} WHERE mod_id = ${modId}`
      }
    }
  })
}

/** What a mod left in Seti that outlives an uninstall unless the user deletes it. */
export async function modFootprint(modId: string): Promise<{ bytes: number; settings: number }> {
  const [row] = await sql<{ bytes: number; settings: number }[]>`SELECT
      (SELECT COALESCE(SUM(bytes), 0)::int FROM mod_data WHERE mod_id = ${modId}) AS bytes,
      (SELECT COUNT(*)::int FROM mod_settings WHERE mod_id = ${modId}) AS settings`
  return row ?? { bytes: 0, settings: 0 }
}
