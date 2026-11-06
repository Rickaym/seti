/** Push subscriptions, one per device; which kinds notify; and agents muted for notifications. */
export const NOTIFICATIONS = `
CREATE TABLE push_device (
  device_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  finished BOOLEAN NOT NULL,
  needs_you BOOLEAN NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE task ADD COLUMN notifications_muted BOOLEAN NOT NULL DEFAULT false;
`
