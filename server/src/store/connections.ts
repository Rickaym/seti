import type {
  ConnectionHeader,
  ConnectionKind,
  ConnectionSlot,
  MintSettings,
  ProfileConnection,
  StoredSecretName,
} from '@seti/shared'
import { now, sql, type Db } from '../db.js'

/** A connection row as the server uses it: settings and its slots' stored names, never a value. */
export interface ConnectionRow {
  id: string
  name: string
  kind: ConnectionKind
  env: string
  placeholder: string
  hosts: string[]
  header: ConnectionHeader | null
  mint: MintSettings | null
  /** The stored secret behind each slot that is set. */
  slots: Partial<Record<ConnectionSlot, StoredSecretName>>
  mint_error: string | null
  mint_checked_at: string | null
  created_at: string
  updated_at: string
}

interface ConnectionRecord {
  id: string
  name: string
  kind: ConnectionKind
  env: string
  placeholder: string
  hosts: string[]
  header: string | null
  template: string | null
  /** Rows from before the issuer field have none. */
  mint: (Omit<MintSettings, 'issuer'> & { issuer?: string | null }) | null
  mint_error: string | null
  mint_checked_at: string | null
  created_at: string
  updated_at: string
  slots: { slot: ConnectionSlot; secret: StoredSecretName }[] | null
}

const toRow = ({ header, template, slots, mint, ...rest }: ConnectionRecord): ConnectionRow => ({
  ...rest,
  mint: mint === null ? null : { ...mint, issuer: mint.issuer ?? null },
  header: header === null || template === null ? null : { name: header, template },
  slots: Object.fromEntries((slots ?? []).map((entry) => [entry.slot, entry.secret])),
})

const SELECT = sql`SELECT c.id, c.name, c.kind, c.env, c.placeholder, c.hosts, c.header, c.template, c.mint,
    c.mint_error, c.mint_checked_at, c.created_at, c.updated_at,
    (SELECT json_agg(json_build_object('slot', s.slot, 'secret', s.secret)) FROM connection_secret s
      WHERE s.connection_id = c.id) AS slots
  FROM connection c`

/** What a new or changed connection stores besides its values. */
export interface ConnectionSettings {
  name: string
  kind: ConnectionKind
  env: string
  hosts: readonly string[]
  header: ConnectionHeader | null
  mint: MintSettings | null
}

/** Connections, their slots and the credentials that carry them; values live in the secret store. */
export const connectionRows = {
  list: async (): Promise<ConnectionRow[]> => (await sql<ConnectionRecord[]>`${SELECT} ORDER BY c.name`).map(toRow),
  get: async (id: string): Promise<ConnectionRow | undefined> => {
    const [record] = await sql<ConnectionRecord[]>`${SELECT} WHERE c.id = ${id}`
    return record && toRow(record)
  },
  byName: async (name: string): Promise<ConnectionRow | undefined> => {
    const [record] = await sql<ConnectionRecord[]>`${SELECT} WHERE c.name = ${name}`
    return record && toRow(record)
  },
  /** The connections a credential carries, in name order. */
  ofProfile: async (profileId: string): Promise<ConnectionRow[]> =>
    (
      await sql<ConnectionRecord[]>`${SELECT}
        WHERE c.id IN (SELECT connection_id FROM credential_profile_connection WHERE profile_id = ${profileId})
        ORDER BY c.name`
    ).map(toRow),
  profileList: async (profileId: string): Promise<ProfileConnection[]> =>
    sql<ProfileConnection[]>`SELECT c.id, c.name, c.env, c.hosts FROM connection c
      JOIN credential_profile_connection pc ON pc.connection_id = c.id
      WHERE pc.profile_id = ${profileId} ORDER BY c.name`,
  /** The credentials that carry the connection, by id and name. */
  profilesOf: async (id: string): Promise<{ id: string; name: string }[]> =>
    sql<{ id: string; name: string }[]>`SELECT p.id, p.name FROM credential_profile p
      JOIN credential_profile_connection pc ON pc.profile_id = p.id
      WHERE pc.connection_id = ${id} ORDER BY (p.id = 'default') DESC, lower(p.name)`,
  envTaken: async (env: string, except: string | null): Promise<string | null> => {
    const [row] = await sql<{ name: string }[]>`SELECT name FROM connection
      WHERE env = ${env} AND id IS DISTINCT FROM ${except}`
    return row?.name ?? null
  },
  insert: async (db: Db, id: string, settings: ConnectionSettings, placeholder: string): Promise<void> => {
    const at = now()
    await db`INSERT INTO connection (id, name, kind, env, placeholder, hosts, header, template, mint, created_at,
        updated_at)
      VALUES (${id}, ${settings.name}, ${settings.kind}, ${settings.env}, ${placeholder}, ${[...settings.hosts]},
        ${settings.header?.name ?? null}, ${settings.header?.template ?? null},
        ${settings.mint === null ? null : db.json(settings.mint)}, ${at}, ${at})`
  },
  update: async (db: Db, id: string, settings: ConnectionSettings): Promise<void> => {
    await db`UPDATE connection SET name = ${settings.name}, env = ${settings.env}, hosts = ${[...settings.hosts]},
        header = ${settings.header?.name ?? null}, template = ${settings.header?.template ?? null},
        mint = ${settings.mint === null ? null : db.json(settings.mint)}, updated_at = ${now()}
      WHERE id = ${id}`
  },
  touch: async (db: Db, id: string): Promise<void> => {
    await db`UPDATE connection SET updated_at = ${now()} WHERE id = ${id}`
  },
  remove: async (db: Db, id: string): Promise<void> => {
    await db`DELETE FROM connection WHERE id = ${id}`
  },
  setSlot: async (db: Db, id: string, slot: ConnectionSlot, secret: StoredSecretName): Promise<void> => {
    await db`INSERT INTO connection_secret (connection_id, slot, secret) VALUES (${id}, ${slot}, ${secret})
      ON CONFLICT (connection_id, slot) DO UPDATE SET secret = excluded.secret`
  },
  clearSlot: async (db: Db, id: string, slot: ConnectionSlot): Promise<void> => {
    await db`DELETE FROM connection_secret WHERE connection_id = ${id} AND slot = ${slot}`
  },
  /** Whether any connection still holds the stored secret. */
  secretUsed: async (db: Db, secret: StoredSecretName): Promise<boolean> =>
    (await db`SELECT 1 FROM connection_secret WHERE secret = ${secret} LIMIT 1`).length > 0,
  /** Carries the connection in exactly these credentials, in the caller's transaction. */
  setProfiles: async (db: Db, id: string, profileIds: readonly string[]): Promise<void> => {
    await db`DELETE FROM credential_profile_connection
      WHERE connection_id = ${id} AND NOT (profile_id = ANY(${[...profileIds]}))`
    await db`INSERT INTO credential_profile_connection (profile_id, connection_id)
      SELECT pid, ${id} FROM unnest(${[...profileIds]}::text[]) AS pid ON CONFLICT DO NOTHING`
  },
  /** Restarts the agents of these credentials at their next turn. */
  touchProfiles: async (db: Db, profileIds: readonly string[]): Promise<void> => {
    await db`UPDATE credential_profile SET updated_at = ${now()} WHERE id = ANY(${[...profileIds]})`
  },
  recordMint: async (id: string, error: string | null): Promise<void> => {
    await sql`UPDATE connection SET mint_error = ${error}, mint_checked_at = ${now()} WHERE id = ${id}`
  },
}
