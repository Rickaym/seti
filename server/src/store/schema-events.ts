/**
 * Columns the readers filter on instead of reading inside a runtime's JSON, filled from the row's
 * neutral events. A row with no `runtime` is not filled yet: ingest fills new rows, and
 * `fillEventColumns` fills older ones in the background, newest first.
 */
export const MESSAGE_EVENTS = `
ALTER TABLE task_message
  ADD COLUMN runtime TEXT,
  ADD COLUMN thread TEXT,
  ADD COLUMN event TEXT,
  ADD COLUMN agent BOOLEAN,
  ADD COLUMN turn_usd DOUBLE PRECISION,
  ADD COLUMN turn_ms DOUBLE PRECISION,
  ADD COLUMN turn_steps INTEGER,
  ADD COLUMN turn_reply BOOLEAN;
CREATE INDEX task_message_unfilled ON task_message(id) WHERE runtime IS NULL;
CREATE INDEX task_message_thread ON task_message(task_id, thread, id) WHERE kind = 'sdk';
CREATE INDEX task_message_event ON task_message(event, id) WHERE kind = 'sdk';
`
