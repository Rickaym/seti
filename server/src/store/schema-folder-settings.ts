/**
 * Folder settings files an agent's session could have written: missing when a sandboxed session
 * started, and the content they had when they appeared.
 */
export const FOLDER_SETTINGS_WATCH = `
CREATE TABLE folder_settings_watch (
  path TEXT PRIMARY KEY,
  appeared_hash TEXT,
  watched_at TEXT NOT NULL
);
`
