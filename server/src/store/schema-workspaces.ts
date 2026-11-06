/**
 * Named groups of agents. Existing agents join a first workspace, Main; a task inserted without
 * one joins the first workspace by position.
 */
export const WORKSPACES = `
CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX workspace_name ON workspace (lower(name));

INSERT INTO workspace (id, name, position, created_at)
VALUES (gen_random_uuid()::text, 'Main', 0, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

CREATE FUNCTION default_workspace_id() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT id FROM workspace ORDER BY position, created_at, id LIMIT 1 $$;

ALTER TABLE task ADD COLUMN workspace_id TEXT NOT NULL DEFAULT default_workspace_id() REFERENCES workspace(id);
CREATE INDEX task_workspace ON task(workspace_id);
`

/** Each workspace's agent grid, shared by every device; it goes with its workspace. */
export const WORKSPACE_GRIDS = `
CREATE TABLE workspace_grid (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  layout JSONB NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`
