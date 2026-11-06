import type { MessageRow } from '@seti/shared'
import { OWN_ROW, sql, toMessage, type MessageRecord } from '../db.js'

/** A window as stored times, each end null when it is open. */
export interface StoredWindow {
  from: string | null
  to: string | null
}

const LAST_REPLY_CHARS = 2000
const OPEN_END = '9999'

/** Rows the default window reads: the user's prompts and the agent's own messages. */
const TALK_ROW = sql`(kind = 'prompt' OR (kind = 'sdk' AND (payload::json ->> 'type') = 'assistant'))`
const NOT_AUTO = sql`COALESCE(payload::json ->> 'auto', 'false') = 'false'`

/** One agent's turns in a window, its first and last row there, and its latest reply. */
interface ActiveRecord {
  task_id: string
  title: string
  workspace_id: string
  status: string
  first_at: string
  last_at: string
  prompts: number
  update_turns: number
  replies: number
  last_reply: string | null
}

export const activity = {
  /** Up to `limit` of the task's own rows in the window before id `before`, newest first. */
  rows: async (
    taskId: string,
    window: StoredWindow,
    page: { before: number; talkOnly: boolean; limit: number },
  ): Promise<MessageRow[]> => {
    const talk = page.talkOnly ? sql`AND ${TALK_ROW}` : sql``
    const records = await sql<MessageRecord[]>`SELECT * FROM task_message WHERE task_id = ${taskId}
      AND created_at >= ${window.from ?? ''} AND created_at < ${window.to ?? OPEN_END} AND id < ${page.before}
      AND ${OWN_ROW} ${talk} ORDER BY id DESC LIMIT ${page.limit}`
    return records.map(toMessage)
  },
  /**
   * Every agent with rows in the window. One agent's rows get ids in time order, so its first and
   * last id in the window bound its prompts and turn results there.
   */
  active: async (window: StoredWindow): Promise<ActiveRecord[]> =>
    sql<ActiveRecord[]>`SELECT t.id AS task_id, t.title, t.workspace_id, t.status, s.first_at, s.last_at,
        p.prompts, p.update_turns, r.replies, r.last_reply
      FROM task t
      CROSS JOIN LATERAL (SELECT min(id) AS low, max(id) AS high, min(created_at) AS first_at,
          max(created_at) AS last_at FROM task_message
        WHERE task_id = t.id AND created_at >= ${window.from ?? ''} AND created_at < ${window.to ?? OPEN_END}) AS s
      CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE ${NOT_AUTO}
            AND COALESCE(payload::json ->> 'queued', '') <> 'removed') AS prompts,
          count(*) FILTER (WHERE NOT ${NOT_AUTO}) AS update_turns
        FROM task_message WHERE task_id = t.id AND kind = 'prompt' AND id BETWEEN s.low AND s.high) AS p
      CROSS JOIN LATERAL (SELECT count(*) AS replies,
          (array_agg(left(payload::json ->> 'result', ${LAST_REPLY_CHARS}) ORDER BY id DESC)
            FILTER (WHERE (payload::json ->> 'subtype') = 'success' AND (payload::json ->> 'result') <> ''))[1]
            AS last_reply
        FROM task_message WHERE kind = 'sdk' AND (payload::json ->> 'type') = 'result'
          AND id BETWEEN s.low AND s.high AND task_id = t.id) AS r
      WHERE s.low IS NOT NULL`,
  /** PRs linked to agents in the window, oldest link first. */
  linkedPrs: async (window: StoredWindow): Promise<{ task_id: string; pr_url: string }[]> =>
    sql<{ task_id: string; pr_url: string }[]>`SELECT task_id, pr_url FROM task_pr
      WHERE linked_at >= ${window.from ?? ''} AND linked_at < ${window.to ?? OPEN_END} ORDER BY linked_at, seq`,
  /** Agents archived since `from`; archiving moved their rows out of task_message. */
  archivedSince: async (from: string | null): Promise<{ id: string; title: string; archived_at: string }[]> =>
    sql<{ id: string; title: string; archived_at: string }[]>`SELECT id, title, archived_at FROM task
      WHERE archived_at >= ${from ?? ''} ORDER BY archived_at DESC`,
  /** The user's timezone as Seti last stored it: the EA's latest follow-up, else a cron reminder. */
  storedZone: async (): Promise<{ zone: string; source: string } | null> => {
    const [row] = await sql<{ zone: string; source: string }[]>`SELECT zone, source FROM (
        (SELECT timezone AS zone, 'the EA''s latest follow-up' AS source, 0 AS rank FROM ea_inbox
          WHERE timezone IS NOT NULL ORDER BY id DESC LIMIT 1)
        UNION ALL
        (SELECT r.timezone, 'the latest cron reminder', 1 FROM channel_reminder r
          JOIN channel c ON c.id = r.channel_id WHERE r.timezone IS NOT NULL ORDER BY c.updated_at DESC LIMIT 1)
      ) AS zones ORDER BY rank LIMIT 1`
    return row ?? null
  },
}
