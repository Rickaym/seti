/** Where the control plane stands in each agent's node journal, kept across its restarts. */
export const NODE_CURSORS = `
CREATE TABLE node_cursor (
  agent TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL
);
`
