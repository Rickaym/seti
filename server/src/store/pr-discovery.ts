import type { MessageBody } from '@seti/shared'
import { now, sql } from '../db.js'

/** A transcript row as stored, its payload still JSON text. */
export interface StoredRow {
  kind: MessageBody['kind']
  payload: string
}

export const prDiscoveryStore = {
  /** Id of the last message already scanned for the task, 0 before the first scan. */
  cursor: async (taskId: string) =>
    (await sql<{ message_id: number }[]>`SELECT message_id FROM pr_discovery_cursor WHERE task_id = ${taskId}`).at(0)
      ?.message_id ?? 0,
  setCursor: async (taskId: string, messageId: number) => {
    await sql`INSERT INTO pr_discovery_cursor (task_id, message_id) VALUES (${taskId}, ${messageId})
      ON CONFLICT (task_id) DO UPDATE SET message_id = excluded.message_id`
  },
  lastMessageId: async (taskId: string) =>
    (await sql<{ id: number }[]>`SELECT COALESCE(MAX(id), 0) AS id FROM task_message WHERE task_id = ${taskId}`).at(0)
      ?.id ?? 0,
  /** Rows after `after` up to and including `upTo` whose payload may hold a PR URL. */
  rowsBetween: async (taskId: string, after: number, upTo: number) => [
    ...(await sql<StoredRow[]>`SELECT kind, payload FROM task_message
      WHERE task_id = ${taskId} AND id > ${after} AND id <= ${upTo} AND strpos(payload, '/pull/') > 0 ORDER BY id`),
  ],
  /** Rows up to `upTo` that may show the task opening or pushing to a PR: calls, results, reports. */
  evidenceRows: async (taskId: string, upTo: number) => [
    ...(await sql<StoredRow[]>`WITH calls AS (
        SELECT id, kind, payload FROM task_message
        WHERE task_id = ${taskId} AND id <= ${upTo} AND kind = 'sdk' AND strpos(payload, '"tool_use"') > 0
          AND (strpos(payload, 'git push') > 0 OR strpos(payload, 'gh pr create') > 0
            OR strpos(payload, '/pulls') > 0 OR strpos(payload, 'create_pull_request') > 0)
      ), published AS (
        SELECT id, kind, payload FROM task_message
        WHERE task_id = ${taskId} AND id <= ${upTo} AND kind = 'sdk'
          AND strpos(payload, '"subtype":"code_change_published"') > 0
      ), ids AS (
        SELECT calls.id AS after, block ->> 'id' AS tool_use_id FROM calls, json_array_elements(
          CASE WHEN json_typeof(payload::json -> 'message' -> 'content') = 'array'
            THEN payload::json -> 'message' -> 'content' ELSE '[]'::json END) AS block
        WHERE block ->> 'type' = 'tool_use'
      ), results AS (
        SELECT result.id, result.kind, result.payload FROM ids CROSS JOIN LATERAL (
          SELECT id, kind, payload FROM task_message
          WHERE task_id = ${taskId} AND id > ids.after AND id <= ${upTo} AND kind = 'sdk'
            AND strpos(payload, '"tool_result"') > 0
            AND strpos(payload, '"tool_use_id":"' || ids.tool_use_id || '"') > 0
          ORDER BY id LIMIT 1) AS result
      )
      SELECT kind, payload FROM (SELECT * FROM calls UNION SELECT * FROM published UNION SELECT * FROM results)
        AS evidence ORDER BY id`),
  ],
  /** Every task that is not archived, most recently updated first. */
  taskIds: async () =>
    (await sql<{ id: string }[]>`SELECT id FROM task WHERE archived_at IS NULL ORDER BY updated_at DESC, id`).map(
      (row) => row.id,
    ),
}

/** PRs the user unlinked from a task, which Seti must not link to it again on its own. */
export const prDismissals = {
  list: async (taskId: string) =>
    new Set(
      (await sql<{ pr_url: string }[]>`SELECT pr_url FROM task_pr_dismissed WHERE task_id = ${taskId}`).map(
        (row) => row.pr_url,
      ),
    ),
  add: async (taskId: string, url: string) => {
    await sql`INSERT INTO task_pr_dismissed (task_id, pr_url, at) VALUES (${taskId}, ${url}, ${now()})
      ON CONFLICT (task_id, pr_url) DO UPDATE SET at = excluded.at`
  },
  remove: async (taskId: string, url: string) => {
    await sql`DELETE FROM task_pr_dismissed WHERE task_id = ${taskId} AND pr_url = ${url}`
  },
}
