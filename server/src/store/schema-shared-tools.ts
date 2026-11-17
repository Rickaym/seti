/**
 * Scripts agents proposed and the user allowed for every agent. The row is the published tool:
 * its code, its hash and the variables it needs; its plugin folder on disk is written from it.
 */
export const SHARED_TOOLS = `
CREATE TABLE shared_tool (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  file TEXT NOT NULL,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  needs TEXT NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  proposer_task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  proposer_title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`
