/**
 * Mods: safe mode, each mod's on or off, its settings, its notification kinds the user turned
 * off or on, and its private key-value data with the size each value takes.
 */
export const MODS = `
CREATE TABLE mod_host (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  safe_mode BOOLEAN NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mod_state (
  mod_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mod_settings (
  mod_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mod_id, key)
);

CREATE TABLE mod_notification (
  mod_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mod_id, kind)
);

CREATE TABLE mod_data (
  mod_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mod_id, key)
);
`

/** The theme the user chose, which every device shows: Seti's own or one a mod adds. */
export const USER_THEME = `
ALTER TABLE user_settings ADD COLUMN theme JSONB;
`

/**
 * The PDF, Sheets and Mermaid mods became the Previews mod's switches: a mod the user had turned
 * off becomes its switch off, and the old ids leave every mod table.
 */
export const PREVIEWS_MOD = `
INSERT INTO mod_settings (mod_id, key, value, updated_at)
SELECT 'previews', mod_id, 'false'::jsonb, updated_at FROM mod_state
WHERE mod_id IN ('pdf', 'sheets', 'mermaid') AND NOT enabled
ON CONFLICT (mod_id, key) DO NOTHING;
DELETE FROM mod_state WHERE mod_id IN ('pdf', 'sheets', 'mermaid');
DELETE FROM mod_settings WHERE mod_id IN ('pdf', 'sheets', 'mermaid');
DELETE FROM mod_notification WHERE mod_id IN ('pdf', 'sheets', 'mermaid');
DELETE FROM mod_data WHERE mod_id IN ('pdf', 'sheets', 'mermaid');
`

/**
 * What's new, GitHub webhooks, poller templates and Previews became required, part of Seti and
 * always on: one the user had turned off goes back on, with an audit event for each.
 */
export const REQUIRED_MODS = `
WITH turned AS (
  UPDATE mod_state
  SET enabled = true, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  WHERE mod_id IN ('whats-new', 'github-webhooks', 'poller-templates', 'previews') AND NOT enabled
  RETURNING mod_id, updated_at
)
INSERT INTO audit_event (at, actor, kind, subject_type, subject_id, summary, detail)
SELECT updated_at, 'system', 'mod.enabled', 'mod', mod_id,
  'Turned the ' || mod_id || ' mod back on, since it is part of Seti now',
  json_build_object('mod', mod_id, 'required', true)::text
FROM turned ORDER BY mod_id;
`

/** Blobs come in one style now, so a stored choice of style goes. */
export const BLOBS_ONE_STYLE = `
DELETE FROM mod_settings WHERE mod_id = 'blobs' AND key = 'style';
`
