import { WARM_CACHE_DEFAULTS, type WarmCacheSeed, type WarmCacheSettings } from '@seti/shared'
import { now, sql } from '../db.js'

interface SettingsRow {
  enabled: boolean
  patterns: string
  max_mb: number
  updated_at: string
}

/** A repo's warm cache settings; the defaults until someone saves them. */
export const warmCacheSettings = {
  get: async (repoId: string): Promise<WarmCacheSettings> => {
    const row = (
      await sql<SettingsRow[]>`SELECT enabled, patterns, max_mb, updated_at FROM repo_warm_cache
        WHERE repo_id = ${repoId}`
    ).at(0)
    if (row === undefined) {
      return { ...WARM_CACHE_DEFAULTS, patterns: [...WARM_CACHE_DEFAULTS.patterns], updated_at: null }
    }
    return { ...row, patterns: JSON.parse(row.patterns) as string[] }
  },
  set: async (repoId: string, input: Omit<WarmCacheSettings, 'updated_at'>): Promise<void> => {
    const patterns = JSON.stringify(input.patterns)
    await sql`INSERT INTO repo_warm_cache (repo_id, enabled, patterns, max_mb, updated_at)
      VALUES (${repoId}, ${input.enabled}, ${patterns}, ${input.max_mb}, ${now()})
      ON CONFLICT (repo_id) DO UPDATE SET enabled = EXCLUDED.enabled, patterns = EXCLUDED.patterns,
        max_mb = EXCLUDED.max_mb, updated_at = EXCLUDED.updated_at`
  },
}

export async function recordWarmCacheSeed(taskId: string, dir: string, seed: WarmCacheSeed): Promise<void> {
  await sql`UPDATE task_worktree SET warm_cache = ${JSON.stringify(seed)} WHERE task_id = ${taskId} AND dir = ${dir}`
}
