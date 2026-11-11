/**
 * Side questions to an agent and their redacted answers, kept apart from the agent's transcript
 * rows so they never reach its session, compaction or search. Deleting the agent deletes them.
 */
export const TASK_ASIDE = `
CREATE TABLE task_aside (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  asked_by TEXT NOT NULL CHECK (asked_by IN ('user', 'ea', 'agent')),
  asker_id TEXT,
  asker_title TEXT,
  cost_usd DOUBLE PRECISION,
  asked_at TEXT NOT NULL,
  answered_at TEXT NOT NULL
);
CREATE INDEX task_aside_task ON task_aside (task_id, asked_at);
CREATE INDEX task_aside_chat ON task_aside (task_id, chat_id, asked_at);
`
