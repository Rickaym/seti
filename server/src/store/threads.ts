import type { FollowedThread, ThreadStopReason } from '@seti/shared'
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

  /** The agent's threads, the ones it still follows first, newest activity first. */
  forTask: async (taskId: string): Promise<FollowedThread[]> =>
    sql<FollowedThread[]>`${SELECT} WHERE task_id = ${taskId}
      ORDER BY (stopped_at IS NULL) DESC, last_activity_at DESC, id DESC`,

  /** Stops the agent's least recently active threads beyond `cap`; returns the ones stopped. */
  stopOverCap: async (taskId: string, cap: number, at: string): Promise<FollowedThread[]> =>
    sql<FollowedThread[]>`UPDATE thread_follow SET stopped_at = ${at}, stop_reason = ${'cap' satisfies ThreadStopReason}
      WHERE id IN (SELECT id FROM thread_follow WHERE task_id = ${taskId} AND stopped_at IS NULL
        ORDER BY last_activity_at DESC, id DESC OFFSET ${cap})
      RETURNING ${COLUMNS}`,
}
