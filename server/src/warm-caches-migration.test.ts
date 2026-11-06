import { DEFAULT_WARM_CACHE_PATTERNS } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { now, repos, sql } from './db.js'
import { MIGRATIONS } from './store/schema.js'
import { warmCacheSettings } from './store/warm-caches.js'

const FIRST_DEFAULTS = [
  '**/*.tsbuildinfo',
  '.eslintcache',
  '**/.next/cache',
  '**/.turbo',
  '**/node_modules/.cache',
  '**/.mypy_cache',
  '**/.ruff_cache',
  '**/.pytest_cache',
]

async function repoWith(name: string, patterns: string[]): Promise<string> {
  const id = `repo-${name}`
  await repos.insert({ id, slug: `test/${name}`, path: `/tmp/${name}`, base_branch: 'main', created_at: now() })
  await warmCacheSettings.set(id, { enabled: false, patterns, max_mb: 512 })
  return id
}

describe('drop_eslintcache_default migration', () => {
  it('drops .eslintcache from lists saved as the first defaults and leaves edited lists alone', async () => {
    const saved = await repoWith('saved', FIRST_DEFAULTS)
    const custom = ['.eslintcache', '**/*.tsbuildinfo']
    const edited = await repoWith('edited', custom)
    const migration = MIGRATIONS.find((entry) => entry.name === 'drop_eslintcache_default')

    await sql.unsafe(migration?.sql ?? '')

    expect(await warmCacheSettings.get(saved)).toMatchObject({
      enabled: false,
      patterns: [...DEFAULT_WARM_CACHE_PATTERNS],
      max_mb: 512,
    })
    expect((await warmCacheSettings.get(edited)).patterns).toEqual(custom)
  })
})
