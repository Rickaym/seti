/** Which MCP servers agents get: servers off by default, and choices per task and routine. */
export const MCP_SELECTION = `
CREATE TABLE mcp_server_default (
  name TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_mcp_server (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (task_id, name)
);

CREATE TABLE routine_mcp_server (
  routine_id TEXT NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (routine_id, name)
);
`

/**
 * Credential profiles for sandboxed tasks. Default takes over the AWS role of aws_settings; its
 * GitHub tokens keep their secret names, so no sealed value moves.
 */
export const CREDENTIAL_PROFILES = `
CREATE TABLE credential_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  aws_role_arn TEXT,
  aws_external_id TEXT,
  aws_region TEXT NOT NULL,
  aws_session_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO credential_profile (id, name, aws_role_arn, aws_external_id, aws_region, aws_session_minutes,
  created_at, updated_at)
SELECT 'default', 'Default', a.role_arn, a.external_id, COALESCE(a.region, 'eu-central-1'),
  COALESCE(a.session_minutes, 60), stamp.at, COALESCE(a.updated_at, stamp.at)
FROM (SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at) AS stamp
LEFT JOIN aws_settings a ON a.id = 1;

DROP TABLE aws_settings;

CREATE TABLE credential_rule (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES credential_profile(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  hosts TEXT[] NOT NULL,
  header TEXT NOT NULL,
  template TEXT NOT NULL,
  secret TEXT,
  minter JSONB,
  mint_error TEXT,
  mint_checked_at TEXT
);
CREATE INDEX credential_rule_profile ON credential_rule(profile_id, position);

ALTER TABLE task ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'
  REFERENCES credential_profile(id) ON DELETE SET DEFAULT;
`

/** The aliases of Host lines in the saved ssh config, which parseSshConfig checked on save. */
const SSH_ALIASES = `
SELECT DISTINCT alias FROM ssh_settings s,
  regexp_split_to_table(s.config, '\\n') AS line,
  regexp_split_to_table(substring(line FROM '^\\s*[Hh][Oo][Ss][Tt](?:\\s*=\\s*|\\s+)(.*)$'), '\\s+') AS alias
WHERE s.id = 1 AND alias <> ''`

/**
 * One model for what agents reach: a default per item and per-task overrides that differ from
 * it. SSH hosts and AWS start off by default, so a task that had the ssh switch on gets every
 * host of the config as an override, and one with AWS on an AWS override; nothing changes.
 * Plugins gain opt-ins beside their opt-outs; pack links become overrides of linked_by_default.
 */
export const ACCESS_DEFAULTS = `
CREATE TABLE access_default (
  kind TEXT NOT NULL,
  item TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, item)
);

CREATE TABLE task_access (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  item TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (task_id, kind, item)
);
CREATE INDEX task_access_item ON task_access(kind, item);

INSERT INTO task_access (task_id, kind, item, enabled)
SELECT t.id, 'ssh', hosts.alias, true FROM task t CROSS JOIN (${SSH_ALIASES}) hosts WHERE t.ssh;

INSERT INTO task_access (task_id, kind, item, enabled) SELECT id, 'aws', 'aws', true FROM task WHERE aws;

ALTER TABLE task DROP COLUMN aws;
ALTER TABLE task DROP COLUMN ssh;

CREATE TABLE task_plugin_optin (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES seti_plugin(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, plugin_id)
);
CREATE INDEX task_plugin_optin_plugin ON task_plugin_optin(plugin_id);

ALTER TABLE task_context_pack ADD COLUMN linked BOOLEAN NOT NULL DEFAULT true;
INSERT INTO task_context_pack (task_id, pack_id, linked)
SELECT t.id, p.id, false FROM task t CROSS JOIN context_pack p
WHERE p.linked_by_default
  AND NOT EXISTS (SELECT 1 FROM task_context_pack tp WHERE tp.task_id = t.id AND tp.pack_id = p.id);
DELETE FROM task_context_pack tp USING context_pack p
WHERE p.id = tp.pack_id AND p.linked_by_default AND tp.linked;
`
