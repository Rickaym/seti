/** The default memory cap of every agent once saved, and the agents with a cap of their own. */
export const MEMORY_CAPS = `
CREATE TABLE memory_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  high_mb INTEGER NOT NULL,
  max_mb INTEGER NOT NULL,
  swap_max_mb INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_memory_cap (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  high_mb INTEGER NOT NULL,
  max_mb INTEGER NOT NULL,
  swap_max_mb INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`
