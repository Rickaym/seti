import type { DreamTidy } from '@seti/shared'
import { now, sql, transaction } from '../db.js'

/** What Seti knows of one of an agent's subscriptions, to judge whether it went unused. */
export interface SubscriptionFacts {
  id: number
  channel_id: string
  channel_name: string
  source: 'webhook' | 'poller' | 'reminder'
  events: string | null
  delivery: string | null
  created_at: string
  last_delivered_at: string | null
  /** Events the channel took since the window began, for anyone. */
  channel_events: number
  /** Their kinds, at most eight. */
  kinds: string[]
  /** A poller's or reminder's switch; null for a webhook. */
  enabled: boolean | null
  failing: boolean | null
  interval_s: number | null
  cron: string | null
  /** The user undid a dream's unsubscribe of it once, so no dream lists it again. */
  kept: boolean
}

/** A subscription row as stored, with its delivery history, so Undo puts back exactly that. */
export interface SubscriptionBefore {
  id: number
  channel_id: string
  task_id: string
  events: string | null
  mode: string
  delivery: string | null
  created_at: string
  deliveries: [number, string][]
}

type TidyRow = DreamTidy & { subject: string; before: SubscriptionBefore }

const toTidy = ({ subject: _subject, before: _before, ...row }: TidyRow): DreamTidy => row

const FACTS = sql`SELECT s.id::int AS id, s.channel_id, c.name AS channel_name, c.source, s.events, s.delivery,
    s.created_at,
    (SELECT MAX(d.delivered_at) FROM channel_event_delivery d WHERE d.subscription_id = s.id) AS last_delivered_at,
    COALESCE(p.enabled, r.enabled) AS enabled, COALESCE(p.failing, r.failing) AS failing,
    COALESCE(p.interval_s, r.interval_s) AS interval_s, r.cron,
    EXISTS (SELECT 1 FROM dream_tidy t WHERE t.kind = 'unsubscribe' AND t.subject = s.id::text
      AND t.state = 'undone') AS kept`

const FROM = sql`FROM channel_subscription s JOIN channel c ON c.id = s.channel_id
  LEFT JOIN channel_poller p ON p.channel_id = s.channel_id
  LEFT JOIN channel_reminder r ON r.channel_id = s.channel_id`

type FactsRow = Omit<SubscriptionFacts, 'channel_events' | 'kinds'>

/** The channel's events since an instant: how many, and their kinds. */
async function channelActivity(channelId: string, since: string) {
  const [row] = await sql<{ count: number; kinds: string[] }[]>`SELECT COUNT(*)::int AS count,
      COALESCE(ARRAY(SELECT DISTINCT e.kind FROM channel_event e WHERE e.channel = ${channelId}
        AND e.created_at >= ${since} AND e.kind <> '' ORDER BY e.kind LIMIT 8), '{}') AS kinds
    FROM channel_event WHERE channel = ${channelId} AND created_at >= ${since}`
  return { channel_events: row?.count ?? 0, kinds: row?.kinds ?? [] }
}

const withActivity = async (rows: FactsRow[], since: string): Promise<SubscriptionFacts[]> =>
  Promise.all(rows.map(async (row) => ({ ...row, ...(await channelActivity(row.channel_id, since)) })))

export const dreamTidies = {
  /** The facts of each subscription of the agent, its own and no other's. */
  subscriptionFacts: async (taskId: string, since: string): Promise<SubscriptionFacts[]> =>
    withActivity(await sql<FactsRow[]>`${FACTS} ${FROM} WHERE s.task_id = ${taskId} ORDER BY s.id`, since),
  /** One subscription's facts, if it is still the agent's. */
  subscriptionFact: async (taskId: string, id: number, since: string): Promise<SubscriptionFacts | undefined> =>
    (
      await withActivity(await sql<FactsRow[]>`${FACTS} ${FROM} WHERE s.id = ${id} AND s.task_id = ${taskId}`, since)
    )[0],
  /** The subscription row and its deliveries, as Undo needs them. */
  before: async (id: number): Promise<SubscriptionBefore | undefined> => {
    const [row] = await sql<Omit<SubscriptionBefore, 'deliveries'>[]>`SELECT id::int AS id, channel_id, task_id,
        events, mode, delivery, created_at FROM channel_subscription WHERE id = ${id} AND target = 'task'`
    if (row === undefined) {
      return undefined
    }
    const deliveries = await sql<{ event_id: number; delivered_at: string }[]>`SELECT event_id::int AS event_id,
        delivered_at FROM channel_event_delivery WHERE subscription_id = ${id} ORDER BY event_id`
    return { ...row, deliveries: deliveries.map((d): [number, string] => [d.event_id, d.delivered_at]) }
  },
  add: async (
    run: { id: number; task_id: string },
    change: { label: string; reason: string; before: SubscriptionBefore },
  ): Promise<DreamTidy> => {
    const [row] = await sql<TidyRow[]>`INSERT INTO dream_tidy
        (run_id, task_id, kind, subject, label, reason, before, state, applied_at)
      VALUES (${run.id}, ${run.task_id}, 'unsubscribe', ${String(change.before.id)}, ${change.label},
        ${change.reason}, ${sql.json({ ...change.before })}, 'applied', ${now()})
      RETURNING id::int AS id, run_id::int AS run_id, task_id, kind, subject, label, reason, before, state,
        applied_at, undone_at`
    if (row === undefined) {
      throw new Error('The change was not recorded')
    }
    return toTidy(row)
  },
  get: async (id: number): Promise<{ tidy: DreamTidy; before: SubscriptionBefore } | undefined> => {
    const [row] = await sql<TidyRow[]>`SELECT id::int AS id, run_id::int AS run_id, task_id, kind, subject, label,
        reason, before, state, applied_at, undone_at FROM dream_tidy WHERE id = ${id}`
    return row && { tidy: toTidy(row), before: row.before }
  },
  /** The agent's latest configuration changes, newest first. */
  forTask: async (taskId: string, limit: number): Promise<DreamTidy[]> =>
    (
      await sql<TidyRow[]>`SELECT id::int AS id, run_id::int AS run_id, task_id, kind, subject, label, reason,
          before, state, applied_at, undone_at FROM dream_tidy WHERE task_id = ${taskId}
        ORDER BY id DESC LIMIT ${limit}`
    ).map(toTidy),
  /**
   * Puts the subscription back with its id and the deliveries whose events still exist, and marks
   * the change undone; a message when it cannot, since the agent subscribed again or the channel
   * or the change is gone.
   */
  restore: async (id: number, before: SubscriptionBefore): Promise<string | null> =>
    transaction(async (tx) => {
      const [taken] = await tx<{ id: number }[]>`SELECT id FROM channel_subscription
        WHERE id = ${before.id} OR (channel_id = ${before.channel_id} AND task_id = ${before.task_id})`
      if (taken !== undefined) {
        return 'the agent subscribes to that channel again already'
      }
      const [channel] = await tx`SELECT 1 FROM channel WHERE id = ${before.channel_id}`
      if (channel === undefined) {
        return 'the channel is gone'
      }
      await tx`INSERT INTO channel_subscription (id, channel_id, target, task_id, events, mode, delivery, created_at)
        VALUES (${before.id}, ${before.channel_id}, 'task', ${before.task_id}, ${before.events}, ${before.mode},
          ${before.delivery}, ${before.created_at})`
      const ids = before.deliveries.map(([eventId]) => eventId)
      const ats = before.deliveries.map(([, at]) => at)
      await tx`INSERT INTO channel_event_delivery (event_id, subscription_id, delivered_at)
        SELECT d.event_id, ${before.id}, d.at FROM unnest(${ids}::bigint[], ${ats}::text[]) AS d(event_id, at)
        WHERE EXISTS (SELECT 1 FROM channel_event e WHERE e.id = d.event_id) ON CONFLICT DO NOTHING`
      const marked = await tx`UPDATE dream_tidy SET state = 'undone', undone_at = ${now()}
        WHERE id = ${id} AND state = 'applied'`
      if (marked.count === 0) {
        throw new Error('The change was undone already')
      }
      return null
    }),
}
