/** Seti's own sign-in: the enforcement switch, passkeys, browser sessions and host setup codes. */
export const SETI_AUTH = `
CREATE TABLE auth_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enforced BOOLEAN NOT NULL,
  user_handle TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE passkey (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL,
  transports TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  name TEXT NOT NULL,
  synced BOOLEAN NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  passkey_id TEXT REFERENCES passkey(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  ip TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_session_expires ON auth_session(expires_at);

CREATE TABLE auth_setup_code (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`
