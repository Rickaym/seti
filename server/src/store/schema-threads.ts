/** Threads agents posted in elsewhere, their own messages there, and replies waiting to be routed. */
export const THREAD_FOLLOWS = `
CREATE TABLE thread_follow (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  space TEXT NOT NULL,
  container TEXT NOT NULL,
  thread TEXT NOT NULL,
  since TEXT NOT NULL,
  url TEXT,
  last_sent_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  replies INTEGER NOT NULL DEFAULT 0,
  stopped_at TEXT,
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, service, container, thread)
);
CREATE INDEX thread_follow_place ON thread_follow (service, container, thread) WHERE stopped_at IS NULL;
CREATE INDEX thread_follow_task ON thread_follow (task_id, last_activity_at);

CREATE TABLE thread_send (
  service TEXT NOT NULL,
  container TEXT NOT NULL,
  message TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (service, container, message)
);

CREATE TABLE thread_reply (
  id BIGSERIAL PRIMARY KEY,
  follow_id BIGINT NOT NULL REFERENCES thread_follow(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  author TEXT NOT NULL,
  author_name TEXT,
  bot BOOLEAN NOT NULL,
  text TEXT NOT NULL,
  url TEXT,
  bytes INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  routed_at TEXT,
  outcome TEXT,
  UNIQUE (follow_id, message)
);
CREATE INDEX thread_reply_due ON thread_reply (received_at) WHERE routed_at IS NULL;
CREATE INDEX thread_reply_recent ON thread_reply (follow_id, received_at);

ALTER TABLE channel ADD COLUMN thread_replies BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE channel ADD COLUMN thread_dms BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE channel ADD COLUMN message_seen_at TEXT;
`
