/** Sends a client may repeat, keyed by its id per target, so a retry takes effect once. */
export const CLIENT_SENDS = `
CREATE TABLE client_send (
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  client_id UUID NOT NULL,
  owner TEXT NOT NULL,
  result TEXT,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, target, client_id)
);
CREATE INDEX client_send_created ON client_send(created_at);
`
