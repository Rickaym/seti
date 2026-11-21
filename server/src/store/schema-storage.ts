/** The automatic clean of idle agents' rebuildable folders: off until the user turns it on. */
export const STORAGE_SETTINGS = `
CREATE TABLE storage_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto_clean BOOLEAN NOT NULL DEFAULT false,
  idle_days INTEGER NOT NULL DEFAULT 14,
  last_run_at TEXT,
  last_freed_bytes BIGINT,
  updated_at TEXT NOT NULL
);
`
