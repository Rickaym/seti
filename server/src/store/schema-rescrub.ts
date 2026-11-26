/**
 * Where the one-time sweep that redacts session material in stored rows resumes: transcript rows
 * below `below`, then permission requests after `after_id`, with the rows it checked and changed.
 */
export const SESSION_RESCRUB = `
CREATE TABLE scrub_backfill (
  target TEXT PRIMARY KEY,
  below BIGINT,
  after_id TEXT,
  checked BIGINT NOT NULL DEFAULT 0,
  changed BIGINT NOT NULL DEFAULT 0
);
INSERT INTO scrub_backfill (target, below) SELECT 'task_message', COALESCE(MAX(id), 0) + 1 FROM task_message;
INSERT INTO scrub_backfill (target, after_id) VALUES ('permission_request', '');
`
