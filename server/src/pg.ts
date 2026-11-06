import postgres from 'postgres'
import { MIGRATIONS } from './store/schema.js'

type Types = Record<'bigint', number>

/** A pooled connection or a transaction; stores take one when they must join a caller's writes. */
export type Db = postgres.ISql<Types>

export type Pool = postgres.Sql<Types>

/** Where the local PostgreSQL server listens; peer auth maps the OS user to its role. */
const PG_SOCKET_DIR = '/var/run/postgresql'

/** A libpq connection URL, so psql and pg_dump take the same value. */
export const socketUrl = (database: string) => `postgresql:///${database}?host=${PG_SOCKET_DIR}`

const INT8_OID = 20
const MIGRATION_LOCK = 0x5e7105

/** Ids and counts are BIGINT; they stay far below 2^53, so they read as plain numbers. */
const types = {
  bigint: {
    to: INT8_OID,
    from: [INT8_OID],
    parse: (value: string) => Number(value),
    serialize: (value: number) => String(value),
  },
}

/** The unix socket directory of a `postgresql:///db?host=/dir` URL, which postgres.js ignores. */
function socketOf(url: URL): string | null {
  const host = url.searchParams.get('host')
  return url.hostname === '' && host?.startsWith('/') === true ? host : null
}

export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1))
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${encodeURIComponent(database)}`
  return parsed.toString()
}

export function connect(url: string, max = 10): Pool {
  const options = {
    max,
    types,
    transform: { undefined: null },
    onnotice: () => undefined,
    connection: { application_name: 'seti' },
  }
  const parsed = new URL(url)
  const socket = socketOf(parsed)
  if (socket === null) {
    return postgres(url, options)
  }
  const user = decodeURIComponent(parsed.username)
  return postgres({ ...options, host: socket, database: databaseOf(url), ...(user === '' ? {} : { user }) })
}

const SAFE_NAME = /^[a-z0-9_]+$/

/** The SQLSTATE of a server error, which the ESM build exposes only on the error object. */
export const errorCode = (e: unknown): string | null =>
  typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : null

const isDuplicateDatabase = (e: unknown) => errorCode(e) === '42P04' || errorCode(e) === '23505'

/** Creates the database when missing, with byte-order collation so ordering matches SQLite. */
export async function ensureDatabase(url: string, template = 'template0'): Promise<void> {
  const name = databaseOf(url)
  if (!SAFE_NAME.test(name) || !SAFE_NAME.test(template)) {
    throw new Error(`Database names must be lowercase letters, digits and underscores: ${name}`)
  }
  const admin = connect(withDatabase(url, 'postgres'), 1)
  try {
    const found = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`
    if (found.length === 0) {
      const locale = template === 'template0' ? ` ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'` : ''
      await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"${locale}`)
    }
  } catch (e) {
    if (!isDuplicateDatabase(e)) {
      throw e
    }
  } finally {
    await admin.end()
  }
}

/** Ends this role's sessions, then drops; DROP stops autovacuum itself, which FORCE refuses to. */
export async function forceDrop(admin: Pool, name: string): Promise<void> {
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = ${name} AND usename = current_user AND pid <> pg_backend_pid()`
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`)
}

export async function dropDatabase(url: string): Promise<void> {
  const name = databaseOf(url)
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Database names must be lowercase letters, digits and underscores: ${name}`)
  }
  const admin = connect(withDatabase(url, 'postgres'), 1)
  try {
    await forceDrop(admin, name)
  } finally {
    await admin.end()
  }
}

/** Applies pending migrations under an advisory lock, so processes starting together take turns. */
export async function migrate(database: Pool): Promise<number[]> {
  return database.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`
    await tx`CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
    const applied = new Set(
      (await tx<{ version: number }[]>`SELECT version FROM schema_migration`).map((r) => r.version),
    )
    const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version))
    for (const migration of pending) {
      await tx.unsafe(migration.sql)
      await migration.run?.(tx)
      await tx`INSERT INTO schema_migration (version, name, applied_at)
        VALUES (${migration.version}, ${migration.name}, ${new Date().toISOString()})`
    }
    return pending.map((migration) => migration.version)
  })
}
