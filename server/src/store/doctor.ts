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
