/** The one switch for Seti's built-in agent guide; no row means the default, on. */
export const AGENT_GUIDE = `
CREATE TABLE agent_guide_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL,
  updated_at TEXT NOT NULL
);
`

const GUIDE_PACK_ID = '5e710000-0000-4000-8000-000000000001'

/** Turns the guide into the built-in pack; while it was on, tasks and routines keep it linked. */
export const SETI_GUIDE_PACK = `
ALTER TABLE context_pack ADD COLUMN builtin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE context_pack ADD COLUMN linked_by_default BOOLEAN NOT NULL DEFAULT false;
UPDATE context_pack SET name = name || ' (yours)' WHERE name = 'Seti guide';
INSERT INTO context_pack (id, name, description, body, builtin, linked_by_default, created_at, updated_at)
SELECT '${GUIDE_PACK_ID}', 'Seti guide', 'How Seti runs agents, their workspace, the group chat and fast tools',
  '', true, COALESCE((SELECT enabled FROM agent_guide_settings WHERE id = 1), true), stamp, stamp
FROM (SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stamp) now_text;
INSERT INTO task_context_pack (task_id, pack_id)
SELECT id, '${GUIDE_PACK_ID}' FROM task WHERE (SELECT linked_by_default FROM context_pack WHERE builtin);
INSERT INTO routine_context_pack (routine_id, pack_id)
SELECT id, '${GUIDE_PACK_ID}' FROM routine WHERE (SELECT linked_by_default FROM context_pack WHERE builtin);
DROP TABLE agent_guide_settings;
`
