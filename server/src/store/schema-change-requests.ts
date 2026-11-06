/**
 * Changes agents ask the user for, with one pending request per agent and change, and the hosts
 * the user allowed for one agent only.
 */
export const CHANGE_REQUESTS = `
CREATE TABLE change_request (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  change TEXT NOT NULL,
  change_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'allowed', 'denied', 'expired')),
  scope TEXT CHECK (scope IN ('agent', 'all')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE UNIQUE INDEX change_request_pending ON change_request (task_id, change_key) WHERE state = 'pending';
CREATE INDEX change_request_task ON change_request (task_id, created_at);
CREATE TABLE task_allowed_host (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  entry TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (task_id, entry)
);
`
