import { sql } from '../db.js'

export interface DeviceRow {
  id: string
  name: string
  platform: string
  /** SPKI DER of the device's P-256 key, base64url. */
  public_key: string
  /** A JSON array of scope names. */
  scopes: string
  created_at: string
  last_seen_at: string | null
  /** Its widgets show agent titles; false shows generic labels. */
  show_names: boolean
}

export interface AndroidAppRow {
  package_name: string | null
  /** A JSON array of fingerprints. */
  cert_sha256: string
  replace_official: boolean
}

const COLUMNS = sql`id, name, platform, public_key, scopes, created_at, last_seen_at, show_names`

export const deviceRows = {
  list: async (): Promise<DeviceRow[]> => sql<DeviceRow[]>`SELECT ${COLUMNS} FROM device ORDER BY created_at, id`,
  get: async (id: string): Promise<DeviceRow | undefined> =>
    (await sql<DeviceRow[]>`SELECT ${COLUMNS} FROM device WHERE id = ${id}`).at(0),
  byKey: async (publicKey: string): Promise<DeviceRow | undefined> =>
    (await sql<DeviceRow[]>`SELECT ${COLUMNS} FROM device WHERE public_key = ${publicKey}`).at(0),
  insert: async (row: DeviceRow): Promise<void> => {
    await sql`INSERT INTO device (id, name, platform, public_key, scopes, created_at, last_seen_at, show_names)
      VALUES (${row.id}, ${row.name}, ${row.platform}, ${row.public_key}, ${row.scopes}, ${row.created_at},
        ${row.last_seen_at}, ${row.show_names})`
  },
  rename: async (id: string, name: string): Promise<boolean> =>
    (await sql`UPDATE device SET name = ${name} WHERE id = ${id} RETURNING id`).length > 0,
  showNames: async (id: string, show: boolean): Promise<boolean> =>
    (await sql`UPDATE device SET show_names = ${show} WHERE id = ${id} RETURNING id`).length > 0,
  seen: async (id: string, at: string): Promise<void> => {
    await sql`UPDATE device SET last_seen_at = ${at} WHERE id = ${id}`
  },
  delete: async (id: string): Promise<boolean> =>
    (await sql`DELETE FROM device WHERE id = ${id} RETURNING id`).length > 0,
}

export const pairingCodeRows = {
  insert: async (hash: string, at: string, expiresAt: string): Promise<void> => {
    await sql`DELETE FROM device_pairing_code WHERE expires_at <= ${at}`
    await sql`INSERT INTO device_pairing_code (code_hash, created_at, expires_at)
      VALUES (${hash}, ${at}, ${expiresAt})`
  },
  /** Uses a code up: true only for the one caller that removed it while it was still valid. */
  consume: async (hash: string, now: string): Promise<boolean> =>
    (
      await sql`DELETE FROM device_pairing_code WHERE code_hash = ${hash} AND expires_at > ${now}
        RETURNING code_hash`
    ).length > 0,
}

export const androidAppRows = {
  get: async (): Promise<AndroidAppRow | undefined> =>
    (await sql<AndroidAppRow[]>`SELECT package_name, cert_sha256, replace_official FROM android_app WHERE id = 1`).at(
      0,
    ),
  set: async (row: AndroidAppRow, at: string): Promise<void> => {
    await sql`INSERT INTO android_app (id, package_name, cert_sha256, replace_official, updated_at)
      VALUES (1, ${row.package_name}, ${row.cert_sha256}, ${row.replace_official}, ${at})
      ON CONFLICT (id) DO UPDATE SET package_name = EXCLUDED.package_name, cert_sha256 = EXCLUDED.cert_sha256,
        replace_official = EXCLUDED.replace_official, updated_at = EXCLUDED.updated_at`
  },
  clear: async (): Promise<void> => {
    await sql`DELETE FROM android_app WHERE id = 1`
  },
}
