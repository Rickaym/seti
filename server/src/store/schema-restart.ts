/**
 * What a restart of Seti cut off, one row per agent: the turn its last stop recorded, how often
 * startup resumed it since it last finished a turn, and why startup stopped resuming it. Pending
 * permission requests keep a hash of their call, so an answer given after a restart fits it.
 */
export const RESTART_CUTS = `
CREATE TABLE restart_cut (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  cut_kind TEXT CHECK (cut_kind IN ('user', 'updates', 'wake')),
  cut_background INTEGER NOT NULL DEFAULT 0,
  cut_at TEXT,
  resumes INTEGER NOT NULL DEFAULT 0,
  window_start TEXT,
  held TEXT
);
ALTER TABLE permission_request ADD COLUMN input_hash TEXT;
`
