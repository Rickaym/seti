/** The default CPU cap of every agent once saved, and the agents with a cap of their own. */
export const CPU_CAPS = `
CREATE TABLE cpu_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  quota_percent INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_cpu_cap (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  quota_percent INTEGER,
  updated_at TEXT NOT NULL
);
`
