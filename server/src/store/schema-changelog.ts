/** Each commit Seti started at, and the commit the user last opened the changelog at. */
export const CHANGELOG = `
CREATE TABLE seti_deploy (
  sha TEXT PRIMARY KEY,
  started_at TEXT NOT NULL
);

CREATE TABLE changelog_seen (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sha TEXT NOT NULL,
  seen_at TEXT NOT NULL
);
`
