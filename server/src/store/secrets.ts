import type { SecretSource, StoredSecretName } from '@seti/shared'
import { now, sql, transaction, type Db } from '../db.js'

export interface SecretRecord {
  name: StoredSecretName
  sealed: string
  source: SecretSource
  created_at: string
  updated_at: string
}

const COLUMNS = sql`name, sealed, source, created_at, updated_at`

/** Sealed secret rows; sealing and opening them is the secrets module's job. */
export const secretRows = {
  get: async (name: StoredSecretName): Promise<SecretRecord | undefined> => {
    const [row] = await sql<SecretRecord[]>`SELECT ${COLUMNS} FROM secret WHERE name = ${name}`
    return row
  },
  list: async (): Promise<SecretRecord[]> => sql<SecretRecord[]>`SELECT ${COLUMNS} FROM secret ORDER BY name`,
  /** Rows whose name starts with the prefix, such as the per-owner GitHub tokens. */
  withPrefix: async (prefix: string): Promise<SecretRecord[]> =>
    sql<SecretRecord[]>`SELECT ${COLUMNS} FROM secret WHERE starts_with(name, ${prefix}) ORDER BY name`,
  put: async (
    { name, sealed, source, at }: { name: StoredSecretName; sealed: string; source: SecretSource; at: string },
    db: Db = sql,
  ): Promise<SecretRecord> => {
    const [row] = await db<SecretRecord[]>`INSERT INTO secret (name, sealed, source, created_at, updated_at)
      VALUES (${name}, ${sealed}, ${source}, ${at}, ${at})
      ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, source = excluded.source,
        updated_at = excluded.updated_at
      RETURNING ${COLUMNS}`
    if (row === undefined) {
      throw new Error(`Could not store the secret ${name}`)
    }
    return row
  },
  /** Stores the value only when the name has none yet; false when one was already there. */
  putIfAbsent: async (name: StoredSecretName, sealed: string, source: SecretSource, at: string): Promise<boolean> => {
    const rows = await sql`INSERT INTO secret (name, sealed, source, created_at, updated_at)
      VALUES (${name}, ${sealed}, ${source}, ${at}, ${at}) ON CONFLICT (name) DO NOTHING RETURNING name`
    return rows.length > 0
  },
  delete: async (name: StoredSecretName, db: Db = sql): Promise<boolean> => {
    const rows = await db`DELETE FROM secret WHERE name = ${name} RETURNING name`
    return rows.length > 0
  },
  deleteWithPrefix: async (prefix: string): Promise<void> => {
    await sql`DELETE FROM secret WHERE starts_with(name, ${prefix})`
  },
  /** When each named row last changed; rows that do not exist are left out. */
  stamps: async (names: readonly StoredSecretName[]): Promise<Map<string, string>> =>
    new Map(
      (
        await sql<{ name: string; updated_at: string }[]>`SELECT name, updated_at FROM secret
          WHERE name = ANY(${[...names]})`
      ).map((row) => [row.name, row.updated_at]),
    ),
  /** Reseals a row in one transaction while `matches` holds for its current value. */
  replaceIf: async (
    name: StoredSecretName,
    matches: (sealed: string) => boolean,
    seal: () => string,
  ): Promise<boolean> =>
    transaction(async (tx) => {
      const [row] = await tx<{ sealed: string }[]>`SELECT sealed FROM secret WHERE name = ${name} FOR UPDATE`
      if (row === undefined || !matches(row.sealed)) {
        return false
      }
      await tx`UPDATE secret SET sealed = ${seal()}, updated_at = ${now()} WHERE name = ${name}`
      return true
    }),
}
