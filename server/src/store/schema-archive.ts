/** Archived tasks: one compressed transcript per task, a flag on search documents, the rule. */
export const TASK_ARCHIVE = `
ALTER TABLE task ADD COLUMN archived_at TEXT;
CREATE INDEX task_archived ON task(archived_at) WHERE archived_at IS NOT NULL;

CREATE TABLE task_archive (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  codec TEXT NOT NULL,
  blob BYTEA NOT NULL,
  chunks TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  raw_bytes BIGINT NOT NULL,
  stored_bytes BIGINT NOT NULL,
  table_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  worktrees TEXT NOT NULL DEFAULT '[]',
  actor TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
ALTER TABLE task_archive ALTER COLUMN blob SET STORAGE EXTERNAL;

ALTER TABLE ea_doc ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

CREATE TABLE archive_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto_enabled INTEGER NOT NULL,
  auto_days INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`

/** Where an archived agent's folders went, and how long archived agents are kept. */
export const ARCHIVE_FILES = `
ALTER TABLE task_archive ADD COLUMN files TEXT;
ALTER TABLE archive_settings ADD COLUMN delete_after_days INTEGER;
`

/** Whether agents a restart cut off resume on their own at startup; on by default. */
export const RESTART_RESUME = `
ALTER TABLE archive_settings ADD COLUMN resume_after_restart BOOLEAN NOT NULL DEFAULT true;
`
