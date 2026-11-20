import type { WebhookFilterInfo, WebhookFilterOutcome } from '@seti/shared'
import { sql } from '../db.js'

/** A webhook's filter as stored; the day's counts come from its hourly rows. */
export type WebhookFilterRecord = Omit<WebhookFilterInfo, 'day'>

export interface WebhookFilterChange {
  script: string
  enabled: boolean
}

const HOUR_MS = 60 * 60 * 1000
/** The hourly rows that make up the last 24 hours: this hour and the 23 before it. */
const HOURS_SHOWN = 24

const hourOf = (at: string) => new Date(Math.floor(Date.parse(at) / HOUR_MS) * HOUR_MS).toISOString()

const firstHour = (at: string) => hourOf(new Date(Date.parse(at) - (HOURS_SHOWN - 1) * HOUR_MS).toISOString())

type DayRow = Record<WebhookFilterOutcome, number>

/** Webhook filters, how often each ran into an error in a row, and what they did each hour. */
export const webhookFilterStore = {
  get: async (channel: string): Promise<WebhookFilterRecord | undefined> => {
    const [row] = await sql<WebhookFilterRecord[]>`SELECT script, enabled, failures, last_error,
        last_error_at, updated_at
      FROM webhook_filter WHERE channel = ${channel}`
    return row
  },
  /** Saves the filter; new code starts with a clean failure count. */
  save: async (channel: string, change: WebhookFilterChange, at: string): Promise<void> => {
    await sql`INSERT INTO webhook_filter (channel, script, enabled, updated_at)
      VALUES (${channel}, ${change.script}, ${change.enabled}, ${at})
      ON CONFLICT (channel) DO UPDATE SET script = excluded.script, enabled = excluded.enabled,
        updated_at = excluded.updated_at,
        failures = CASE WHEN webhook_filter.script = excluded.script THEN webhook_filter.failures ELSE 0 END,
        last_error = CASE WHEN webhook_filter.script = excluded.script THEN webhook_filter.last_error END,
        last_error_at = CASE WHEN webhook_filter.script = excluded.script THEN webhook_filter.last_error_at END`
  },
  remove: async (channel: string): Promise<void> => {
    await sql`DELETE FROM webhook_filter WHERE channel = ${channel}`
    await sql`DELETE FROM webhook_filter_hour WHERE channel = ${channel}`
  },
  /** Counts one run in its hour; a failure adds to the failures in a row, a success clears them. */
  record: async (channel: string, outcome: WebhookFilterOutcome, error: string | null, at: string): Promise<void> => {
    const failed = outcome === 'failed'
    await sql`UPDATE webhook_filter SET
        failures = CASE WHEN ${failed} THEN failures + 1 ELSE 0 END,
        last_error = CASE WHEN ${failed} THEN ${error}::text ELSE last_error END,
        last_error_at = CASE WHEN ${failed} THEN ${at}::text ELSE last_error_at END
      WHERE channel = ${channel}`
    const one = (name: WebhookFilterOutcome) => (outcome === name ? 1 : 0)
    await sql`INSERT INTO webhook_filter_hour (channel, hour, kept, changed, dropped, failed)
      VALUES (${channel}, ${hourOf(at)}, ${one('kept')}, ${one('changed')}, ${one('dropped')}, ${one('failed')})
      ON CONFLICT (channel, hour) DO UPDATE SET kept = webhook_filter_hour.kept + excluded.kept,
        changed = webhook_filter_hour.changed + excluded.changed,
        dropped = webhook_filter_hour.dropped + excluded.dropped,
        failed = webhook_filter_hour.failed + excluded.failed`
    await sql`DELETE FROM webhook_filter_hour WHERE channel = ${channel} AND hour < ${firstHour(at)}`
  },
  /** What the filter did over the last 24 hours, by outcome. */
  day: async (channel: string, at: string): Promise<DayRow> => {
    const [row] = await sql<DayRow[]>`SELECT COALESCE(sum(kept), 0)::int AS kept,
        COALESCE(sum(changed), 0)::int AS changed, COALESCE(sum(dropped), 0)::int AS dropped,
        COALESCE(sum(failed), 0)::int AS failed
      FROM webhook_filter_hour WHERE channel = ${channel} AND hour >= ${firstHour(at)}`
    return row ?? { kept: 0, changed: 0, dropped: 0, failed: 0 }
  },
  /** Whether any webhook has a filter on, so a worker can start before the first delivery. */
  anyEnabled: async (): Promise<boolean> => {
    const [row] = await sql<{ on: boolean }[]>`SELECT EXISTS (SELECT 1 FROM webhook_filter WHERE enabled) AS on`
    return row?.on === true
  },
}
