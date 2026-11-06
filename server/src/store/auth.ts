import { randomBytes } from 'node:crypto'
import { sql, transaction } from '../db.js'

export interface AuthSettingsRow {
  enforced: boolean
  /** The WebAuthn user handle every passkey of this Seti shares, base64url. */
  user_handle: string
}

export interface PasskeyRow {
  id: string
  credential_id: string
  /** The COSE public key, base64url. */
  public_key: string
  counter: number
  /** A JSON array of the authenticator's transports. */
  transports: string
  rp_id: string
  name: string
  synced: boolean
  created_at: string
  last_used_at: string | null
}

export interface SessionRow {
  id: string
  token_hash: string
  passkey_id: string | null
  host: string
  user_agent: string
  ip: string | null
  created_at: string
  last_seen_at: string
  expires_at: string
}

export interface SessionListRow extends SessionRow {
  passkey_name: string | null
}

const PASSKEY_COLUMNS = sql`id, credential_id, public_key, counter, transports, rp_id, name, synced, created_at,
  last_used_at`

export const authSettingsRows = {
  /** The settings row, made on first read with enforcement off and a fresh user handle. */
  get: async (at: string): Promise<AuthSettingsRow> => {
    await sql`INSERT INTO auth_settings (id, enforced, user_handle, updated_at)
      VALUES (1, false, ${randomBytes(32).toString('base64url')}, ${at}) ON CONFLICT (id) DO NOTHING`
    const [row] = await sql<AuthSettingsRow[]>`SELECT enforced, user_handle FROM auth_settings WHERE id = 1`
    if (row === undefined) {
      throw new Error('auth_settings has no row')
    }
    return row
  },
  setEnforced: async (enforced: boolean, at: string): Promise<void> => {
    await sql`UPDATE auth_settings SET enforced = ${enforced}, updated_at = ${at} WHERE id = 1`
  },
}

export const passkeyRows = {
  list: async (): Promise<PasskeyRow[]> =>
    sql<PasskeyRow[]>`SELECT ${PASSKEY_COLUMNS} FROM passkey ORDER BY created_at, id`,
  get: async (id: string): Promise<PasskeyRow | undefined> =>
    (await sql<PasskeyRow[]>`SELECT ${PASSKEY_COLUMNS} FROM passkey WHERE id = ${id}`).at(0),
  byCredential: async (credentialId: string): Promise<PasskeyRow | undefined> =>
    (await sql<PasskeyRow[]>`SELECT ${PASSKEY_COLUMNS} FROM passkey WHERE credential_id = ${credentialId}`).at(0),
  countFor: async (rpId: string): Promise<number> =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM passkey WHERE rp_id = ${rpId}`).at(0)?.n ?? 0,
  count: async (): Promise<number> =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM passkey`).at(0)?.n ?? 0,
  insert: async (row: PasskeyRow): Promise<void> => {
    await sql`INSERT INTO passkey (id, credential_id, public_key, counter, transports, rp_id, name, synced,
        created_at, last_used_at)
      VALUES (${row.id}, ${row.credential_id}, ${row.public_key}, ${row.counter}, ${row.transports}, ${row.rp_id},
        ${row.name}, ${row.synced}, ${row.created_at}, ${row.last_used_at})`
  },
  rename: async (id: string, name: string): Promise<boolean> =>
    (await sql`UPDATE passkey SET name = ${name} WHERE id = ${id} RETURNING id`).length > 0,
  used: async (id: string, counter: number, at: string): Promise<void> => {
    await sql`UPDATE passkey SET counter = ${counter}, last_used_at = ${at} WHERE id = ${id}`
  },
  /** Deletes a passkey unless it is the last for `keepHost`, the host's rows locked throughout. */
  deleteUnlessLast: async (id: string, keepHost: string | null): Promise<'deleted' | 'last' | 'missing'> =>
    transaction(async (tx) => {
      if (keepHost !== null) {
        const held = await tx<{ id: string }[]>`SELECT id FROM passkey WHERE rp_id = ${keepHost}
          ORDER BY id FOR UPDATE`
        if (held.length <= 1 && held.some((row) => row.id === id)) {
          return 'last'
        }
      }
      const removed = await tx`DELETE FROM passkey WHERE id = ${id} RETURNING id`
      return removed.length > 0 ? 'deleted' : 'missing'
    }),
}

export const sessionRows = {
  insert: async (row: SessionRow): Promise<void> => {
    await sql`INSERT INTO auth_session (id, token_hash, passkey_id, host, user_agent, ip, created_at, last_seen_at,
        expires_at)
      VALUES (${row.id}, ${row.token_hash}, ${row.passkey_id}, ${row.host}, ${row.user_agent}, ${row.ip},
        ${row.created_at}, ${row.last_seen_at}, ${row.expires_at})`
  },
  byTokenHash: async (hash: string): Promise<SessionListRow | undefined> =>
    (
      await sql<SessionListRow[]>`SELECT s.*, p.name AS passkey_name FROM auth_session s
        LEFT JOIN passkey p ON p.id = s.passkey_id WHERE s.token_hash = ${hash}`
    ).at(0),
  /** Sessions still within their absolute and idle limits, newest first. */
  list: async (now: string, idleSince: string): Promise<SessionListRow[]> =>
    sql<SessionListRow[]>`SELECT s.*, p.name AS passkey_name FROM auth_session s
      LEFT JOIN passkey p ON p.id = s.passkey_id
      WHERE s.expires_at > ${now} AND s.last_seen_at > ${idleSince}
      ORDER BY s.last_seen_at DESC, s.id`,
  seen: async (id: string, at: string): Promise<void> => {
    await sql`UPDATE auth_session SET last_seen_at = ${at} WHERE id = ${id}`
  },
  /** Records a fresh passkey check in the session, which consent to mods needs. */
  steppedUp: async (id: string, at: string): Promise<void> => {
    await sql`UPDATE auth_session SET stepped_up_at = ${at} WHERE id = ${id}`
  },
  steppedUpAt: async (id: string): Promise<string | null> =>
    (await sql<{ stepped_up_at: string | null }[]>`SELECT stepped_up_at FROM auth_session WHERE id = ${id}`).at(0)
      ?.stepped_up_at ?? null,
  delete: async (id: string): Promise<boolean> =>
    (await sql`DELETE FROM auth_session WHERE id = ${id} RETURNING id`).length > 0,
  deleteByTokenHash: async (hash: string): Promise<void> => {
    await sql`DELETE FROM auth_session WHERE token_hash = ${hash}`
  },
  prune: async (now: string, idleSince: string): Promise<void> => {
    await sql`DELETE FROM auth_session WHERE expires_at <= ${now} OR last_seen_at <= ${idleSince}`
  },
}

export const setupCodeRows = {
  insert: async (hash: string, at: string, expiresAt: string): Promise<void> => {
    await sql`DELETE FROM auth_setup_code WHERE expires_at <= ${at}`
    await sql`INSERT INTO auth_setup_code (code_hash, created_at, expires_at) VALUES (${hash}, ${at}, ${expiresAt})`
  },
  valid: async (hash: string, now: string): Promise<boolean> =>
    (await sql`SELECT 1 FROM auth_setup_code WHERE code_hash = ${hash} AND expires_at > ${now}`).length > 0,
  /** Uses a code up: true only for the one caller that removed it while it was still valid. */
  consume: async (hash: string, now: string): Promise<boolean> =>
    (await sql`DELETE FROM auth_setup_code WHERE code_hash = ${hash} AND expires_at > ${now} RETURNING code_hash`)
      .length > 0,
}
