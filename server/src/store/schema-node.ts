/** Where the control plane stands in each agent's node journal, kept across its restarts. */
export const NODE_CURSORS = `
CREATE TABLE node_cursor (
  agent TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL
);
`

/** The prompt row each node ask recorded, so the same ask after a restart gets that row again. */
export const NODE_PROMPTS = `
CREATE TABLE node_prompt (
  ask_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  prompt_id BIGINT NOT NULL REFERENCES task_message(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX node_prompt_at ON node_prompt(at);
`
