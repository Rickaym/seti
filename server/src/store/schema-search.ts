/** Visible transcript text, kept by triggers and indexed for substring and word search. */
export const MESSAGE_SEARCH = `
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;

CREATE FUNCTION message_search_part(value text, cap integer) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NULLIF(btrim(regexp_replace(regexp_replace(left(value, cap), '\\S{200,}', ' ', 'g'), '\\s+', ' ', 'g')), '')
$$;

CREATE FUNCTION message_search_block(block jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE block ->> 'type'
    WHEN 'text' THEN message_search_part(block ->> 'text', 8000)
    WHEN 'tool_use' THEN concat_ws(' ', block ->> 'name', message_search_part(COALESCE(
      block -> 'input' ->> 'command', block -> 'input' ->> 'file_path', block -> 'input' ->> 'pattern',
      block -> 'input' ->> 'description', block -> 'input' ->> 'url', block -> 'input' ->> 'query',
      (block -> 'input')::text), 300))
    WHEN 'tool_result' THEN message_search_part(CASE jsonb_typeof(block -> 'content')
      WHEN 'string' THEN block ->> 'content'
      WHEN 'array' THEN (SELECT string_agg(part ->> 'text', ' ') FROM jsonb_array_elements(block -> 'content') AS part
        WHERE part ->> 'type' = 'text')
    END, 2000)
  END
$$;

CREATE FUNCTION message_search_local_output(content jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT message_search_part(substring(btrim(
    CASE jsonb_typeof(content)
      WHEN 'string' THEN content #>> '{}'
      ELSE (SELECT string_agg(block ->> 'text', '') FROM jsonb_array_elements(content) AS block
        WHERE block ->> 'type' = 'text')
    END) FROM '^<local-command-stdout>(.*)</local-command-stdout>$'), 2000)
$$;

CREATE FUNCTION message_search_text(kind text, payload text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  j jsonb := payload::jsonb;
  content jsonb;
BEGIN
  CASE kind
    WHEN 'prompt' THEN
      RETURN CASE WHEN j ->> 'auto' = 'true' THEN NULL ELSE message_search_part(j ->> 'text', 8000) END;
    WHEN 'input', 'notice' THEN
      RETURN message_search_part(concat_ws(' ', j ->> 'title', j ->> 'subject', left(j ->> 'body', 4000)), 4400);
    WHEN 'seti' THEN
      RETURN message_search_part(j ->> 'error', 2000);
    WHEN 'shell' THEN
      RETURN message_search_part(concat_ws(' ', left(j ->> 'command', 1000), left(j ->> 'stdout', 2000),
        left(j ->> 'stderr', 2000)), 5000);
    WHEN 'sdk' THEN
      IF j ->> 'parent_tool_use_id' IS NOT NULL THEN
        RETURN NULL;
      END IF;
      content := j -> 'message' -> 'content';
      IF j ->> 'type' = 'assistant' AND jsonb_typeof(content) = 'array' THEN
        RETURN left((SELECT string_agg(message_search_block(block), ' ') FROM jsonb_array_elements(content) AS block),
          12000);
      END IF;
      IF j ->> 'type' = 'user' AND jsonb_typeof(content) = 'array' THEN
        RETURN COALESCE(left((SELECT string_agg(message_search_block(block), ' ') FROM jsonb_array_elements(content)
          AS block WHERE block ->> 'type' = 'tool_result'), 12000), message_search_local_output(content));
      END IF;
      IF j ->> 'type' = 'user' AND jsonb_typeof(content) = 'string' THEN
        RETURN message_search_local_output(content);
      END IF;
      RETURN NULL;
    ELSE
      RETURN NULL;
  END CASE;
END
$$;

CREATE TABLE message_search (
  message_id BIGINT PRIMARY KEY REFERENCES task_message(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body TEXT NOT NULL
) WITH (toast_tuple_target = 8160);
ALTER TABLE message_search ALTER COLUMN body SET STORAGE MAIN;
CREATE INDEX message_search_task ON message_search(task_id, message_id);
CREATE INDEX message_search_trgm ON message_search USING gin (task_id, body public.gin_trgm_ops);
CREATE INDEX message_search_words ON message_search USING gin (task_id, to_tsvector('simple'::regconfig, body));

CREATE FUNCTION message_search_added() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO message_search (message_id, task_id, kind, created_at, body)
  SELECT id, task_id, kind, created_at, body
  FROM (SELECT id, task_id, kind, created_at, message_search_text(kind, payload) AS body FROM added) AS rows
  WHERE body IS NOT NULL
  ON CONFLICT (message_id) DO UPDATE SET body = EXCLUDED.body;
  RETURN NULL;
END
$$;

CREATE FUNCTION message_search_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  body text := message_search_text(NEW.kind, NEW.payload);
BEGIN
  IF body IS NULL THEN
    DELETE FROM message_search WHERE message_id = NEW.id;
  ELSE
    INSERT INTO message_search (message_id, task_id, kind, created_at, body)
    VALUES (NEW.id, NEW.task_id, NEW.kind, NEW.created_at, body)
    ON CONFLICT (message_id) DO UPDATE SET body = EXCLUDED.body;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER task_message_search_added AFTER INSERT ON task_message
  REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION message_search_added();
CREATE TRIGGER task_message_search_changed AFTER UPDATE OF payload ON task_message
  FOR EACH ROW WHEN (OLD.payload IS DISTINCT FROM NEW.payload) EXECUTE FUNCTION message_search_changed();

CREATE TABLE message_search_backfill (below BIGINT NOT NULL);
INSERT INTO message_search_backfill SELECT COALESCE(MAX(id), 0) + 1 FROM task_message;

CREATE INDEX team_message_trgm ON team_message USING gin (text public.gin_trgm_ops);
CREATE INDEX team_message_words ON team_message USING gin (to_tsvector('simple'::regconfig, text));
`

/**
 * The conversation alone in a second column: the user's prompts, updates handed to the agent and
 * the agent's text replies, without tool calls, tool output, shell runs or Seti's notes.
 */
export const MESSAGE_SEARCH_TALK = `
CREATE FUNCTION message_search_talk(kind text, payload text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  j jsonb := payload::jsonb;
  content jsonb := j -> 'message' -> 'content';
BEGIN
  CASE kind
    WHEN 'prompt', 'input' THEN
      RETURN message_search_text(kind, payload);
    WHEN 'sdk' THEN
      IF j ->> 'type' IS DISTINCT FROM 'assistant' OR j ->> 'parent_tool_use_id' IS NOT NULL
        OR jsonb_typeof(content) IS DISTINCT FROM 'array' THEN
        RETURN NULL;
      END IF;
      RETURN left((SELECT string_agg(message_search_part(block ->> 'text', 8000), ' ') FROM jsonb_array_elements(content)
        AS block WHERE block ->> 'type' = 'text'), 12000);
    ELSE
      RETURN NULL;
  END CASE;
END
$$;

ALTER TABLE message_search ADD COLUMN talk TEXT;
ALTER TABLE message_search ALTER COLUMN talk SET STORAGE MAIN;

CREATE OR REPLACE FUNCTION message_search_added() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO message_search (message_id, task_id, kind, created_at, body, talk)
  SELECT id, task_id, kind, created_at, body, message_search_talk(kind, payload)
  FROM (SELECT id, task_id, kind, created_at, payload, message_search_text(kind, payload) AS body FROM added) AS rows
  WHERE body IS NOT NULL
  ON CONFLICT (message_id) DO UPDATE SET body = EXCLUDED.body, talk = EXCLUDED.talk;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION message_search_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  body text := message_search_text(NEW.kind, NEW.payload);
  talk text := message_search_talk(NEW.kind, NEW.payload);
BEGIN
  IF body IS NULL THEN
    DELETE FROM message_search WHERE message_id = NEW.id;
  ELSE
    INSERT INTO message_search (message_id, task_id, kind, created_at, body, talk)
    VALUES (NEW.id, NEW.task_id, NEW.kind, NEW.created_at, body, talk)
    ON CONFLICT (message_id) DO UPDATE SET body = EXCLUDED.body, talk = EXCLUDED.talk;
  END IF;
  RETURN NULL;
END
$$;

UPDATE message_search AS s SET talk = message_search_talk(m.kind, m.payload)
FROM task_message AS m WHERE m.id = s.message_id AND s.kind IN ('prompt', 'input', 'sdk');

CREATE INDEX message_search_talk_trgm ON message_search USING gin (task_id, talk public.gin_trgm_ops)
  WHERE talk IS NOT NULL;
CREATE INDEX message_search_talk_words ON message_search USING gin (task_id, to_tsvector('simple'::regconfig, talk))
  WHERE talk IS NOT NULL;
`

/** Finds one agent's messages in a time window, for reading what it did on a day. */
export const MESSAGE_TIME = 'CREATE INDEX task_message_created ON task_message(task_id, created_at);'
