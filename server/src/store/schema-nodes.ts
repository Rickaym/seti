/**
 * Adds what the link to a separate session process keeps: how far each agent's journal is stored,
 * the answers to asks for a day, and the boot of the process each node last connected from.
 */
export const NODE_LINK = `
CREATE TABLE node_cursor (
  task_id TEXT PRIMARY KEY,
  epoch TEXT NOT NULL,
  seq BIGINT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE node_ask (
  id TEXT PRIMARY KEY,
  reply TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX node_ask_created ON node_ask (created_at);
CREATE TABLE node_boot (
  node_id TEXT PRIMARY KEY,
  boot_id TEXT NOT NULL,
  seen_at TEXT NOT NULL
);
`
