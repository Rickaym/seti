/**
 * Questions agents ask the user through AskUserQuestion, one row each, grouped by the tool call
 * that asked them. An open question holds its agent's call until the whole group is settled.
 */
export const QUESTIONS = `
CREATE TABLE question (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  subagent_id TEXT,
  tool_use_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  header TEXT NOT NULL,
  prompt TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('choice', 'yes_no')),
  multi BOOLEAN NOT NULL,
  options TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'dismissed', 'expired')),
  answer TEXT,
  answered_by TEXT CHECK (answered_by IN ('user', 'ea')),
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX question_open ON question (status, created_at);
CREATE INDEX question_task ON question (task_id, created_at);
CREATE INDEX question_group ON question (group_id, position);
`

/**
 * Secret questions an agent asks with ask_secret: the kind, and what the secret is for and where
 * it goes as JSON. The value itself is never stored here.
 */
export const QUESTION_SECRETS = `
ALTER TABLE question DROP CONSTRAINT question_kind_check;
ALTER TABLE question ADD CONSTRAINT question_kind_check CHECK (kind IN ('choice', 'yes_no', 'secret'));
ALTER TABLE question ADD COLUMN secret TEXT;
`
