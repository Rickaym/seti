import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, vi } from 'vitest'
import { dropDatabase } from './pg.js'
import { cloneTestDatabase } from './test-db.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-test-'))
process.env.SETI_HOME ??= path.join(root, 'seti')
process.env.SETI_CLAUDE_HOME ??= path.join(root, 'claude')
process.env.SETI_SCRATCH_ROOT ??= path.join(root, 'work')
/** Task sessions ask gh for a token; tests must never get the developer's. */
process.env.GH_CONFIG_DIR = path.join(root, 'gh')
delete process.env.GH_TOKEN
delete process.env.GITHUB_TOKEN
/** STS lookups in tests find no credentials rather than this machine's instance role. */
process.env.AWS_EC2_METADATA_DISABLED = 'true'
/** Agents run without systemd scopes; the scope tests start their own. */
process.env.SETI_MEMORY_SCOPES = 'off'
/** The sample mod joins the mod host, off until a test turns it on. */
process.env.SETI_TEST_MODS ??= '1'

/** Waits default to 10 s instead of 1 s: the suite shares a busy host with agents and CI. */
const waitFor = vi.waitFor.bind(vi)
vi.waitFor = async (callback, options) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: 10_000, ...options })

/** Each test file gets its own database, cloned from the migrated template. */
const databaseUrl = await cloneTestDatabase()
process.env.SETI_DATABASE_URL = databaseUrl
/** Caching stays out of unit tests; the Redis tests turn it on for themselves. */
process.env.SETI_REDIS_URL = 'off'

afterAll(async () => {
  const { shutdown } = await import('./background.js')
  await shutdown()
  const { closeDatabase } = await import('./db.js')
  const { clearCache, closeRedis } = await import('./redis.js')
  await clearCache()
  await Promise.all([closeDatabase(), closeRedis()])
  await dropDatabase(databaseUrl)
  fs.rmSync(root, { recursive: true, force: true })
})
