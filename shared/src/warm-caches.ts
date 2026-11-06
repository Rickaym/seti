import { z } from 'zod'

/** Gitignored build caches copied into a new worktree, in the order they are taken. */
export const DEFAULT_WARM_CACHE_PATTERNS = [
  '**/*.tsbuildinfo',
  '**/.next/cache',
  '**/.turbo',
  '**/node_modules/.cache',
  '**/.mypy_cache',
  '**/.ruff_cache',
  '**/.pytest_cache',
] as const

export const WARM_CACHE_DEFAULT_MB = 2048
export const WARM_CACHE_MAX_MB = 20_480
export const WARM_CACHE_MAX_PATTERNS = 40

const PATTERN_CHARS = /^[\w.*@+/-]+$/

const segments = (pattern: string) => pattern.split('/')

/** Why a cache pattern is refused, or null when it is fine. */
export function warmCachePatternProblem(pattern: string): string | null {
  if (!PATTERN_CHARS.test(pattern)) {
    return `${pattern}: use letters, digits and . _ - @ + * / only`
  }
  if (pattern.startsWith('/') || pattern.endsWith('/') || pattern.includes('//')) {
    return `${pattern}: give a path relative to the checkout, without a leading or trailing /`
  }
  const parts = segments(pattern)
  if (parts.some((part) => part === '.' || part === '..')) {
    return `${pattern}: . and .. are not allowed`
  }
  if (parts.some((part) => part === '.git')) {
    return `${pattern}: nothing under .git is copied`
  }
  if (parts.some((part) => part.startsWith('.env'))) {
    return `${pattern}: .env files are never copied`
  }
  if (parts.every((part) => part === '**' || part === '*')) {
    return `${pattern}: name a cache, not every path`
  }
  return null
}

const pattern = z
  .string()
  .trim()
  .min(1, 'a pattern cannot be empty')
  .max(200)
  .superRefine((value, ctx) => {
    const problem = warmCachePatternProblem(value)
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: problem })
    }
  })

export const warmCacheSettingsInput = z.object({
  enabled: z.boolean(),
  patterns: z
    .array(pattern)
    .max(WARM_CACHE_MAX_PATTERNS, `at most ${String(WARM_CACHE_MAX_PATTERNS)} patterns`)
    .refine((list) => new Set(list).size === list.length, 'each pattern once'),
  max_mb: z
    .number()
    .int()
    .min(1, 'at least 1 MB')
    .max(WARM_CACHE_MAX_MB, `at most ${String(WARM_CACHE_MAX_MB)} MB`),
})
export type WarmCacheSettingsInput = z.input<typeof warmCacheSettingsInput>

export interface WarmCacheSettings {
  enabled: boolean
  patterns: string[]
  max_mb: number
  /** Null while the defaults apply. */
  updated_at: string | null
}

export const WARM_CACHE_DEFAULTS: Omit<WarmCacheSettings, 'updated_at'> = {
  enabled: true,
  patterns: [...DEFAULT_WARM_CACHE_PATTERNS],
  max_mb: WARM_CACHE_DEFAULT_MB,
}

/** A repo's warm cache settings, with a note when its typecheck cannot be warmed. */
export interface WarmCacheStatus {
  repo_id: string
  settings: WarmCacheSettings
  defaults: Omit<WarmCacheSettings, 'updated_at'>
  hint: string | null
}

export type WarmCacheOutcome = 'seeded' | 'empty' | 'off' | 'timeout' | 'failed'

/** What seeding a new worktree copied; sizes in bytes. */
export interface WarmCacheSeed {
  repo: string
  outcome: WarmCacheOutcome
  /** `main` is the repo's own checkout; `worktree` another Seti worktree with newer caches. */
  source: 'main' | 'worktree' | null
  source_dir: string | null
  paths: number
  bytes: number
  ms: number
  /** Paths left out, such as over the size cap or outside the checkout. */
  skipped: number
  reason: string | null
}

const MB = 1024 * 1024

function sizeWords(bytes: number): string {
  if (bytes >= 1024 * MB) {
    return `${(bytes / (1024 * MB)).toFixed(1)} GB`
  }
  if (bytes >= MB) {
    return `${String(Math.round(bytes / MB))} MB`
  }
  return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`
}

const SOURCE_WORDS = { main: 'main checkout', worktree: 'a newer worktree' } as const

/** One compact line, such as `3 paths, 410 MB from main checkout`. */
export function warmCacheSummary(seed: WarmCacheSeed): string {
  switch (seed.outcome) {
    case 'off':
      return 'off for this repo'
    case 'empty':
      return 'none found to copy'
    case 'failed':
      return `not copied: ${seed.reason ?? 'failed'}`
    case 'seeded':
    case 'timeout': {
      const from = seed.source === null ? '' : ` from ${SOURCE_WORDS[seed.source]}`
      const what = `${String(seed.paths)} ${seed.paths === 1 ? 'path' : 'paths'}, ${sizeWords(seed.bytes)}${from}`
      return seed.outcome === 'timeout' ? `${what}, stopped at the time limit` : what
    }
  }
}

/** The one-line note for the audit log, or null when seeding was off or found nothing to copy. */
export function warmCacheNote(seeds: readonly WarmCacheSeed[]): string | null {
  const tried = seeds.filter((seed) => seed.outcome !== 'off' && seed.outcome !== 'empty')
  if (tried.length === 0) {
    return null
  }
  if (tried.length === 1 && tried[0] !== undefined) {
    return `Warm caches: ${warmCacheSummary(tried[0])}`
  }
  const each = tried.map((seed) => `${seed.repo} ${warmCacheSummary(seed)}`)
  return `Warm caches: ${each.join('; ')}`
}
