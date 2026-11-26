import type { FollowedThread, ListedThread, ThreadReach, ThreadStopReason } from '@seti/shared'
import { sql } from '../db.js'

/** A message an agent sent outside Seti, with the thread it belongs to. */
export interface SentMessage {
  service: string
  space: string
  container: string
  thread: string
  message: string
  url: string | null
}

const COLUMNS = sql`id::int AS id, task_id, service, space, container AS channel, thread, since, url,
  last_sent_at, last_activity_at, replies, stopped_at, stop_reason, created_at`

const SELECT = sql`SELECT ${COLUMNS} FROM thread_follow`

/** What recording a send did to the agent's follow of its thread. */
interface Recorded {
  follow: FollowedThread
  /** True when the agent was not following the thread before this send. */
  started: boolean
}

async function follow(taskId: string, sent: SentMessage): Promise<FollowedThread | undefined> {
  const [row] = await sql<FollowedThread[]>`${SELECT}
    WHERE task_id = ${taskId} AND service = ${sent.service} AND container = ${sent.container} AND thread = ${sent.thread}`
  return row
}

export const threadFollows = {
  /** Records the agent's message and follows its thread, again if it had stopped. */
  recordSend: async (taskId: string, sent: SentMessage, at: string): Promise<Recorded> => {
    const before = await follow(taskId, sent)
    await sql`INSERT INTO thread_send (service, container, message, task_id, sent_at)
      VALUES (${sent.service}, ${sent.container}, ${sent.message}, ${taskId}, ${at}) ON CONFLICT DO NOTHING`
    const [row] = await sql<FollowedThread[]>`INSERT INTO thread_follow
        (task_id, service, space, container, thread, since, url, last_sent_at, last_activity_at, created_at)
      VALUES (${taskId}, ${sent.service}, ${sent.space}, ${sent.container}, ${sent.thread}, ${sent.message},
        ${sent.url}, ${at}, ${at}, ${at})
      ON CONFLICT (task_id, service, container, thread) DO UPDATE SET
        space = CASE WHEN thread_follow.space = '' THEN excluded.space ELSE thread_follow.space END,
        url = COALESCE(thread_follow.url, excluded.url),
        last_sent_at = excluded.last_sent_at, last_activity_at = excluded.last_activity_at,
        stopped_at = NULL, stop_reason = NULL
      RETURNING ${COLUMNS}`
    if (row === undefined) {
      throw new Error('the followed thread was not stored')
    }
    return { follow: row, started: before?.stopped_at !== null }
  },

  /** Threads live agents follow, and webhooks with thread replies on (THR-8). */
  reach: async (): Promise<ThreadReach> => {
    const [row] = await sql<ThreadReach[]>`SELECT
        (SELECT count(*)::int FROM thread_follow f JOIN task t ON t.id = f.task_id
          WHERE f.stopped_at IS NULL AND t.archived_at IS NULL) AS following,
        (SELECT count(*)::int FROM channel WHERE thread_replies) AS reading`
    return row ?? { following: 0, reading: 0 }
  },

  /** The agent's threads, the ones it still follows first, newest activity first. */
  forTask: async (taskId: string): Promise<ListedThread[]> =>
    sql<ListedThread[]>`SELECT f.id::int AS id, f.task_id, f.service, f.space, f.container AS channel, f.thread,
        f.since, f.url, f.last_sent_at, f.last_activity_at, f.replies, f.stopped_at, f.stop_reason, f.created_at,
        n.name AS channel_name
      FROM thread_follow f
      LEFT JOIN slack_name n ON n.id = f.container AND f.service = 'slack'
      WHERE f.task_id = ${taskId}
      ORDER BY (f.stopped_at IS NULL) DESC, f.last_activity_at DESC, f.id DESC`,

  /** Stops the agent's least recently active threads beyond `cap`; returns the ones stopped. */
  stopOverCap: async (taskId: string, cap: number, at: string): Promise<FollowedThread[]> =>
    sql<FollowedThread[]>`UPDATE thread_follow SET stopped_at = ${at}, stop_reason = ${'cap' satisfies ThreadStopReason}
      WHERE id IN (SELECT id FROM thread_follow WHERE task_id = ${taskId} AND stopped_at IS NULL
        ORDER BY last_activity_at DESC, id DESC OFFSET ${cap})
      RETURNING ${COLUMNS}`,
}
