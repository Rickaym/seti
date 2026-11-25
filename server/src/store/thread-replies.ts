import type { FollowedThread, ThreadStopReason } from '@seti/shared'
import { sql } from '../db.js'
import type { InboundMessage } from '../threads/sources.js'

const FOLLOW = sql`id::int AS id, task_id, service, space, container AS channel, thread, since, url,
  last_sent_at, last_activity_at, replies, stopped_at, stop_reason, created_at`

/** A reply waiting to be routed, with the thread it belongs to. */
export interface PendingReply {
  id: number
  follow_id: number
  task_id: string
  message: string
  author: string
  author_name: string | null
  bot: boolean
  text: string
  url: string | null
  bytes: number
  received_at: string
  service: string
  space: string
  channel: string
  thread: string
  stopped: boolean
}

/** Outcomes of a reply that reached the agent, as deliverInputs reports them. */
const SENT = ['delivered', 'queued', 'held']

export const threadReplies = {
  /** Whether a Seti agent sent this message itself. */
  isAgentSend: async (service: string, container: string, message: string): Promise<boolean> =>
    (
      await sql`SELECT 1 FROM thread_send WHERE service = ${service} AND container = ${container}
      AND message = ${message}`
    ).length > 0,

  /** Followed threads this message replies in, for each agent whose first message there is older. */
  inThread: async (msg: InboundMessage, thread: string): Promise<FollowedThread[]> =>
    sql<FollowedThread[]>`SELECT ${FOLLOW} FROM thread_follow WHERE service = ${msg.service}
      AND container = ${msg.container} AND thread = ${thread} AND stopped_at IS NULL AND since < ${msg.message}`,

  /** The followed thread of the agent that wrote last in a direct message, since `sentAfter`. */
  latestDirect: async (msg: InboundMessage, sentAfter: string): Promise<FollowedThread | undefined> => {
    const [row] = await sql<FollowedThread[]>`SELECT ${FOLLOW} FROM thread_follow WHERE service = ${msg.service}
      AND container = ${msg.container} AND stopped_at IS NULL AND since < ${msg.message}
      AND last_sent_at >= ${sentAfter}
      ORDER BY last_sent_at DESC, id DESC LIMIT 1`
    return row
  },

  /** Queues a reply for one followed thread; false when it was queued before. */
  add: async (reply: { follow: number; msg: InboundMessage; text: string; url: string | null }, at: string) => {
    const { follow: followId, msg } = reply
    const added = await sql`INSERT INTO thread_reply
        (follow_id, message, author, author_name, bot, text, url, bytes, received_at)
      VALUES (${followId}, ${msg.message}, ${msg.author}, ${msg.author_name}, ${msg.bot}, ${reply.text},
        ${reply.url}, ${Buffer.byteLength(msg.text)}, ${at})
      ON CONFLICT (follow_id, message) DO NOTHING RETURNING id`
    await sql`UPDATE thread_follow SET last_activity_at = ${at} WHERE id = ${followId}`
    return added.length > 0
  },

  /** Replies received before `before` that wait to be routed, oldest first. */
  due: async (before: string, limit: number): Promise<PendingReply[]> =>
    sql<PendingReply[]>`SELECT r.id::int AS id, r.follow_id::int AS follow_id, f.task_id, r.message, r.author,
        r.author_name, r.bot, r.text, r.url, r.bytes, r.received_at, f.service, f.space, f.container AS channel,
        f.thread, (f.stopped_at IS NOT NULL) AS stopped
      FROM thread_reply r JOIN thread_follow f ON f.id = r.follow_id
      WHERE r.routed_at IS NULL AND r.received_at <= ${before}
      ORDER BY r.received_at, r.id LIMIT ${limit}`,

  /** Records what became of a reply and forgets its text. */
  settle: async (id: number, outcome: string, at: string): Promise<void> => {
    await sql`UPDATE thread_reply SET routed_at = ${at}, outcome = ${outcome}, text = '' WHERE id = ${id}`
  },

  /** Replies of a followed thread that reached its agent since `since`. */
  sentSince: async (followId: number, since: string): Promise<number> => {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM thread_reply
      WHERE follow_id = ${followId} AND received_at >= ${since} AND outcome IN ${sql(SENT)}`
    return row?.n ?? 0
  },

  counted: async (followId: number): Promise<void> => {
    await sql`UPDATE thread_follow SET replies = replies + 1 WHERE id = ${followId}`
  },

  /** Stops following a thread; undefined when it was stopped already or is gone. */
  stop: async (followId: number, reason: ThreadStopReason, at: string): Promise<FollowedThread | undefined> => {
    const [row] = await sql<FollowedThread[]>`UPDATE thread_follow SET stopped_at = ${at}, stop_reason = ${reason}
      WHERE id = ${followId} AND stopped_at IS NULL RETURNING ${FOLLOW}`
    return row
  },

  /** Stops threads quiet since `quietBefore` or followed since before `startedBefore`. */
  expire: async (quietBefore: string, startedBefore: string, at: string): Promise<FollowedThread[]> =>
    sql<FollowedThread[]>`UPDATE thread_follow SET stopped_at = ${at},
        stop_reason = CASE WHEN created_at < ${startedBefore} THEN 'age' ELSE 'quiet' END
      WHERE stopped_at IS NULL AND (last_activity_at < ${quietBefore} OR created_at < ${startedBefore})
      RETURNING ${FOLLOW}`,

  /** Forgets routed replies received before `before`. */
  prune: async (before: string): Promise<void> => {
    await sql`DELETE FROM thread_reply WHERE routed_at IS NOT NULL AND received_at < ${before}`
  },
}

/** A webhook's thread switches and when it last delivered a message event. */
export const channelThreads = {
  set: async (channel: string, change: { replies?: boolean | undefined; dms?: boolean | undefined }) => {
    await sql`UPDATE channel SET thread_replies = COALESCE(${change.replies ?? null}, thread_replies),
      thread_dms = COALESCE(${change.dms ?? null}, thread_dms) WHERE id = ${channel}`
  },
  /** Notes a message event, writing at most once an hour. */
  sawMessage: async (channel: string, at: string, hourAgo: string): Promise<void> => {
    await sql`UPDATE channel SET message_seen_at = ${at}
      WHERE id = ${channel} AND (message_seen_at IS NULL OR message_seen_at < ${hourAgo})`
  },
}
