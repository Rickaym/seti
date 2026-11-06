/** Per-repo settings for seeding new worktrees with build caches, and what each seed copied. */
export const WARM_CACHES = `
CREATE TABLE repo_warm_cache (
  repo_id TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL,
  patterns TEXT NOT NULL,
  max_mb INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE task_worktree ADD COLUMN warm_cache TEXT;
`

/** The default patterns migration 27 shipped with, which saving the Edit repo dialog stores as is. */
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

/** Lists saved as the first defaults drop .eslintcache, which ESLint keys by absolute path. */
export const DROP_ESLINTCACHE_DEFAULT = `
UPDATE repo_warm_cache SET patterns = '${JSON.stringify(FIRST_DEFAULTS.filter((p) => p !== '.eslintcache'))}'
  WHERE patterns = '${JSON.stringify(FIRST_DEFAULTS)}';
`
