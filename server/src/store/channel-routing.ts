import type { ChannelEvent } from '@seti/shared'
import { sql } from '../db.js'

/** How long a new event may wait for the delivery that stored it before the sweeper routes it. */
const IN_FLIGHT_S = 30
const RETRY_BASE_S = 30
const RETRY_CAP_S = 3600
/** Tries before Seti gives up on routing an event; the waits between them double up to an hour. */
export const ROUTE_ATTEMPTS = 12

/**
 * Which subscribers each stored event reached. An event is routed once every subscriber took it;
 * until then the sweeper routes it again, to the subscribers it has not reached yet.
 */
export const channelRouting = {
  /** The subscriptions this event reached already. */
  reached: async (eventId: number): Promise<Set<number>> =>
    new Set(
      (
        await sql<{ subscription_id: string }[]>`SELECT subscription_id FROM channel_event_delivery
          WHERE event_id = ${eventId}`
      ).map((row) => Number(row.subscription_id)),
    ),
  reach: async (eventId: number, subscriptionId: number, at: string): Promise<void> => {
    await sql`INSERT INTO channel_event_delivery (event_id, subscription_id, delivered_at)
      VALUES (${eventId}, ${subscriptionId}, ${at}) ON CONFLICT DO NOTHING`
  },
  routed: async (eventId: number, at: string): Promise<void> => {
    await sql`UPDATE channel_event SET routed_at = ${at}, route_error = NULL WHERE id = ${eventId}`
  },
  /** Counts a failed try and sets when to try again; returns the tries so far. */
  failed: async (eventId: number, error: string, at: string): Promise<number> => {
    const [row] = await sql<{ route_attempts: number }[]>`UPDATE channel_event
      SET route_attempts = route_attempts + 1, route_error = ${error},
        retry_at = to_char((${at}::timestamptz + make_interval(secs => least(${RETRY_CAP_S},
          ${RETRY_BASE_S} * power(2, route_attempts)))) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      WHERE id = ${eventId} RETURNING route_attempts`
    return row?.route_attempts ?? 0
  },
  /** Unrouted events due for another try, oldest first; a new one waits out its own delivery first. */
  due: async (at: string, limit: number): Promise<ChannelEvent[]> => [
    ...(await sql<ChannelEvent[]>`SELECT id, channel, source, severity, title, detail, url, dedupe_key, kind, subject,
        state, occurred_at, created_at FROM channel_event
      WHERE routed_at IS NULL AND route_attempts < ${ROUTE_ATTEMPTS}
        AND COALESCE(retry_at, to_char((created_at::timestamptz + make_interval(secs => ${IN_FLIGHT_S}))
          AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) <= ${at}
      ORDER BY id LIMIT ${limit}`),
  ],
}
