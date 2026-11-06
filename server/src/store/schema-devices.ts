import { OFFICIAL_ANDROID_APP } from '@seti/shared'
import type { Db } from '../pg.js'

/** Paired devices with their public keys, one-time pairing codes and the Android app's identity. */
export const DEVICES = `
CREATE TABLE device (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE device_pairing_code (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE android_app (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  package_name TEXT,
  cert_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

/** The android_app row becomes a self-built app next to the official one, or in its place. */
export const ANDROID_OVERRIDE = 'ALTER TABLE android_app ADD COLUMN replace_official BOOLEAN NOT NULL DEFAULT false;'

/** Each device's widgets show agent titles until the user hides them for that device. */
export const DEVICE_SHOW_NAMES = 'ALTER TABLE device ADD COLUMN show_names BOOLEAN NOT NULL DEFAULT true;'

/** Drops a row that names only the official app, which Seti now trusts without one. */
export async function dropOfficialAndroidRow(tx: Db): Promise<void> {
  const [row] = await tx<{ package_name: string | null; cert_sha256: string }[]>`
    SELECT package_name, cert_sha256 FROM android_app WHERE id = 1`
  if (row === undefined) {
    return
  }
  const prints: unknown = JSON.parse(row.cert_sha256)
  const official =
    row.package_name === OFFICIAL_ANDROID_APP.package_name &&
    Array.isArray(prints) &&
    prints.every((print) => OFFICIAL_ANDROID_APP.cert_sha256.includes(String(print)))
  if (official || row.package_name === null) {
    await tx`DELETE FROM android_app WHERE id = 1`
  }
}
