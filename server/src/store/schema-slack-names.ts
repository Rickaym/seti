/** Names of Slack channels and people Seti saw beside their ids, so it can show names, not ids. */
export const SLACK_NAMES = `
CREATE TABLE slack_name (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  learned_at TEXT NOT NULL
);
`
