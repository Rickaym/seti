/** The default compaction rule of every agent once saved, and the agents with a rule of their own. */
export const COMPACT_RULES = `
CREATE TABLE compact_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto BOOLEAN NOT NULL,
  window_k INTEGER,
  threshold_pct INTEGER,
  instructions TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_compact (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  auto BOOLEAN NOT NULL,
  window_k INTEGER,
  threshold_pct INTEGER,
  instructions TEXT,
  updated_at TEXT NOT NULL
);
`
