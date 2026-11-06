/** Public share links: the switch, each share by its token hash, its frozen copy and its views. */
export const SHARES = `
CREATE TABLE share_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE share (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  root TEXT NOT NULL,
  path TEXT NOT NULL,
  real_path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  version INTEGER NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  scan_override BOOLEAN NOT NULL
);
CREATE INDEX share_task_path ON share(task_id, root, path);

CREATE TABLE share_blob (
  share_id TEXT PRIMARY KEY REFERENCES share(id) ON DELETE CASCADE,
  content BYTEA NOT NULL,
  page TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL
);
ALTER TABLE share_blob ALTER COLUMN content SET STORAGE EXTERNAL;

CREATE TABLE share_asset (
  share_id TEXT NOT NULL REFERENCES share(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (share_id, ref)
);

CREATE TABLE share_view (
  id BIGSERIAL PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES share(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  country TEXT,
  user_agent TEXT NOT NULL
);
CREATE INDEX share_view_share ON share_view(share_id, id DESC);
`

/** Previews: page images, the link card, what the preview shows, and link previews by unfurlers. */
export const SHARE_PREVIEWS = `
ALTER TABLE share ADD COLUMN link_preview BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE share ADD COLUMN unfurl_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE share_blob ADD COLUMN preview_label TEXT NOT NULL DEFAULT '';
ALTER TABLE share_blob ADD COLUMN preview_note TEXT;
ALTER TABLE share_blob ADD COLUMN preview_error TEXT;
ALTER TABLE share_blob ADD COLUMN image_key TEXT;
ALTER TABLE share_blob ADD COLUMN card BYTEA;
ALTER TABLE share_blob ADD COLUMN preview_bytes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE share_image (
  share_id TEXT NOT NULL REFERENCES share(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  mime TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  PRIMARY KEY (share_id, n)
);
ALTER TABLE share_image ALTER COLUMN bytes SET STORAGE EXTERNAL;

ALTER TABLE share_view ADD COLUMN unfurler TEXT;
`
