import { createHash } from 'node:crypto'
import { connect, ensureDatabase, forceDrop, migrate, socketUrl, withDatabase } from './pg.js'
import { MIGRATIONS } from './store/schema.js'

/** Where test databases live: SETI_TEST_DATABASE_URL (CI), else the local server's socket. */
const TEST_SERVER_URL = process.env.SETI_TEST_DATABASE_URL ?? socketUrl('postgres')

/** Test files clone this database, so each starts from the current schema in milliseconds. */
const TEMPLATE = `seti_test_tpl_${createHash('sha256')
  .update(MIGRATIONS.map((migration) => `${String(migration.version)}\n${migration.sql}`).join('\n'))
  .digest('hex')
  .slice(0, 12)}`

const PREFIX = 'seti_test_'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Other branches' templates are left alone until nobody has prepared them for this long. */
const TEMPLATE_IDLE_MS = 24 * 60 * 60 * 1000

/** Serialises template work across concurrent test runs on one database server. */
const TEMPLATE_LOCK = 734_117_211

/** Builds the template once per schema and drops databases that crashed test runs left behind. */
export async function prepareTestDatabases(): Promise<void> {
  const admin = connect(TEST_SERVER_URL, 1)
  try {
    await admin`SELECT pg_advisory_lock(${TEMPLATE_LOCK})`
    const pattern = `${PREFIX}%`
    const rows = await admin<{ datname: string; note: string | null }[]>`
      SELECT datname, shobj_description(oid, 'pg_database') AS note FROM pg_database WHERE datname LIKE ${pattern}`
    for (const { datname: name, note } of rows) {
      const pid = /^seti_test_run_(\d+)_/.exec(name)?.[1]
      const idle = Date.now() - Number(note ?? 0) > TEMPLATE_IDLE_MS
      const stale = name.startsWith(`${PREFIX}tpl_`)
        ? name !== TEMPLATE && idle
        : pid !== undefined && !alive(Number(pid))
      if (stale) {
        await forceDrop(admin, name)
      }
    }
    if (!rows.some((row) => row.datname === TEMPLATE)) {
      const building = `${TEMPLATE}_building`
      const url = withDatabase(TEST_SERVER_URL, building)
      await forceDrop(admin, building)
      await ensureDatabase(url)
      const template = connect(url, 1)
      try {
        await migrate(template)
      } finally {
        await template.end()
      }
      await admin.unsafe(`ALTER DATABASE "${building}" RENAME TO "${TEMPLATE}"`)
    }
    await admin.unsafe(`COMMENT ON DATABASE "${TEMPLATE}" IS '${String(Date.now())}'`)
  } finally {
    await admin`SELECT pg_advisory_unlock(${TEMPLATE_LOCK})`.catch(() => undefined)
    await admin.end()
  }
}

let count = 0

/** A fresh database cloned from the template, named after this process so cleanup can find it. */
export async function cloneTestDatabase(): Promise<string> {
  count += 1
  const name = `${PREFIX}run_${String(process.pid)}_${String(count)}_${String(Date.now())}`
  const url = withDatabase(TEST_SERVER_URL, name)
  await ensureDatabase(url, TEMPLATE)
  return url
}
