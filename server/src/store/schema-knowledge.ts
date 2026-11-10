/**
 * Notes agents propose and the user approves, with a full-text index over the approved text. A
 * note scoped to a repo keeps its repo id after the repo goes, so it reaches no agent then.
 */
export const KNOWLEDGE = `
CREATE TABLE knowledge_note (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('how-to', 'fact', 'gotcha', 'environment')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  verify TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  repo_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'stale')),
  proposer TEXT NOT NULL CHECK (proposer IN ('agent', 'ea', 'user')),
  proposer_task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  proposer_title TEXT,
  corrects_id TEXT REFERENCES knowledge_note(id) ON DELETE SET NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  decided_at TEXT,
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body || ' ' || verify)) STORED
);
CREATE INDEX knowledge_note_status ON knowledge_note (status, repo_id);
CREATE INDEX knowledge_note_proposer ON knowledge_note (proposer_task_id, created_at);
CREATE INDEX knowledge_note_search ON knowledge_note USING gin (tsv);
`
