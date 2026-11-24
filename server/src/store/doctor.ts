import { DEFAULT_PROFILE_ID } from '@seti/shared'
import type { Db } from '../pg.js'

/** Read-only probes `seti doctor` runs on its own connection, outside the server's pool. */
export const doctorProbes = {
  serverVersion: async (db: Db): Promise<number> => {
    const [row] = await db<{ server_version_num: string }[]>`SHOW server_version_num`
    return Math.floor(Number(row?.server_version_num ?? '0') / 10_000)
  },
  canCreateDatabases: async (db: Db): Promise<boolean> => {
    const [row] = await db<{ ok: boolean }[]>`SELECT rolcreatedb OR rolsuper AS ok FROM pg_roles
      WHERE rolname = current_user`
    return row?.ok === true
  },
  /** Applied migration versions, or null before the first start made the table. */
  appliedMigrations: async (db: Db): Promise<number[] | null> => {
    const [table] = await db<{ name: string | null }[]>`SELECT to_regclass('schema_migration')::text AS name`
    if (table?.name === null || table === undefined) {
      return null
    }
    return (await db<{ version: number }[]>`SELECT version FROM schema_migration ORDER BY version`).map(
      (row) => row.version,
    )
  },
  hasSecret: async (db: Db, name: string): Promise<boolean> => {
    const [table] = await db<{ name: string | null }[]>`SELECT to_regclass('secret')::text AS name`
    if (table?.name === null || table === undefined) {
      return false
    }
    return (await db`SELECT 1 FROM secret WHERE name = ${name}`).length > 0
  },
  /** Calls Seti's permission shadow compared since the day, by outcome, and how many were slow. */
  policyShadow: async (db: Db, since: string): Promise<Record<string, number>> => {
    const [table] = await db<{ name: string | null }[]>`SELECT to_regclass('policy_shadow')::text AS name`
    if (table?.name === null || table === undefined) {
      return {}
    }
    const rows = await db<{ result: string; calls: string }[]>`SELECT result, SUM(calls) AS calls
      FROM policy_shadow WHERE day >= ${since} GROUP BY result
      UNION ALL SELECT 'slow', COALESCE(SUM(calls), 0) FROM policy_shadow WHERE day >= ${since} AND slow`
    return Object.fromEntries(rows.map((row) => [row.result, Number(row.calls)]))
  },
  /**
   * Whether Codex is on, the program the user named in place of Seti's copy, and the hosts of the
   * default credential's connections that set a header and hold a value; null before the table.
   */
  codex: async (db: Db): Promise<{ program: string | null; keyHosts: string[][] } | null> => {
    const [table] = await db<{ name: string | null }[]>`SELECT to_regclass('codex_settings')::text AS name`
    if (table?.name === null || table === undefined) {
      return null
    }
    const [row] = await db<{ enabled: boolean; program: string | null }[]>`SELECT enabled, program
      FROM codex_settings WHERE id = 1`
    if (row?.enabled !== true) {
      return null
    }
    const keys = await db<{ hosts: string[] }[]>`SELECT c.hosts FROM connection c
      JOIN credential_profile_connection pc ON pc.connection_id = c.id
      WHERE pc.profile_id = ${DEFAULT_PROFILE_ID} AND c.header IS NOT NULL
        AND EXISTS (SELECT 1 FROM connection_secret s WHERE s.connection_id = c.id)`
    return { program: row.program, keyHosts: keys.map((key) => key.hosts) }
  },
  /** Whether pgvector is installed in this database, available to install, or neither. */
  vector: async (db: Db): Promise<'installed' | 'available' | 'missing'> => {
    const [row] = await db<{ installed: string | null }[]>`SELECT installed_version AS installed
      FROM pg_available_extensions WHERE name = 'vector'`
    if (row === undefined) {
      return 'missing'
    }
    return row.installed === null ? 'available' : 'installed'
  },
}
