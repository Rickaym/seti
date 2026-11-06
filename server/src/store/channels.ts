import {
  webhookMapping,
  type ChannelSecretPending,
  type ChannelDelivery,
  type ChannelDeliveryStatus,
  type ChannelEvent,
  type ChannelRoute,
  type ChannelSource,
  type ChannelState,
  type WebhookMapping,
} from '@seti/shared'
import type { ChannelEventDraft } from '../channels/types.js'
import { sql, transaction, type Db } from '../db.js'
import { isSealed } from '../secret-box.js'
import { storeBox } from '../secrets.js'

/** A webhook channel with its secret opened; only the receiver reads the secret. */
export interface ChannelRecord {
  id: string
  name: string
  /** The webhook source, such as generic or github-webhooks.github. */
  preset: string
  /** Null when the stored secret does not open with the current key, so no delivery verifies. */
  secret: string | null
  mapping: WebhookMapping
  created_at: string
  updated_at: string
  secret_rotated_at: string | null
  secret_pending: ChannelSecretPending | null
}

type Row = Omit<ChannelRecord, 'mapping' | 'secret'> & {
  mapping: string
  secret: string
}

const secretContext = (id: string) => `channel:${id}`

const seal = (id: string, secret: string) => storeBox().seal(secret, secretContext(id))

/** Rows from before the secret store hold the secret in the clear until sealLegacySecrets runs. */
function openSecret(row: Row): string | null {
  if (!isSealed(row.secret)) {
    return row.secret
  }
  try {
    return storeBox().open(row.secret, secretContext(row.id))
  } catch (e) {
    process.stderr.write(`channels: the secret of ${row.name} does not open: ${e instanceof Error ? e.message : ''}\n`)
    return null
  }
}

function toRecord(row: Row): ChannelRecord {
  const mapping = webhookMapping.safeParse(JSON.parse(row.mapping))
  return {
    ...row,
    secret: openSecret(row),
    mapping: mapping.success ? mapping.data : {},
  }
}

export type NewChannel = Omit<ChannelRecord, 'updated_at' | 'secret_rotated_at' | 'secret'> & { secret: string }

export interface ChannelChange {
  name?: string | undefined
  mapping?: WebhookMapping | undefined
}

export interface NewDelivery {
  channel: string
  received_at: string
  status: ChannelDeliveryStatus
  http_status: number
  reason: string
  delivery_id: string | null
  event_id?: number | null
  excerpt?: string
  routes?: ChannelRoute[]
}

type DeliveryRow = Omit<ChannelDelivery, 'routes'> & { routes: string }

/** What became of a verified delivery: a new event, or why none was stored. */
export type Accepted =
  | { kind: 'event'; event: ChannelEvent }
  | { kind: 'duplicate' }
  | { kind: 'unchanged'; state: ChannelState }
  | { kind: 'baseline' }

const DELIVERIES_KEPT = 100

/**
 * Stores an event unless its key was seen, or its subject's state did not change. A subject first
 * seen in the up state only sets the baseline.
 */
async function recordEvent(tx: Db, channel: string, draft: ChannelEventDraft, at: string): Promise<Accepted> {
  if (draft.subject !== undefined && draft.state !== undefined) {
    const [last] = await tx<{ state: ChannelState }[]>`SELECT state FROM channel_subject
      WHERE channel = ${channel} AND subject = ${draft.subject} FOR UPDATE`
    if (last?.state === draft.state) {
      return { kind: 'unchanged', state: draft.state }
    }
    await tx`INSERT INTO channel_subject (channel, subject, state, changed_at)
      VALUES (${channel}, ${draft.subject}, ${draft.state}, ${at})
      ON CONFLICT (channel, subject) DO UPDATE SET state = excluded.state, changed_at = excluded.changed_at`
    if (last === undefined && draft.state === 'up') {
      return { kind: 'baseline' }
    }
  }
  const [row] = await tx<ChannelEvent[]>`INSERT INTO channel_event (channel, dedupe_key, source, severity,
      title, detail, url, kind, subject, state, occurred_at, created_at)
    VALUES (${channel}, ${draft.dedupe_key}, ${draft.source}, ${draft.severity}, ${draft.title},
      ${draft.detail}, ${draft.url}, ${draft.kind}, ${draft.subject ?? null}, ${draft.state ?? null},
      ${draft.occurred_at}, ${at})
    ON CONFLICT (channel, dedupe_key) DO NOTHING RETURNING *`
  return row === undefined ? { kind: 'duplicate' } : { kind: 'event', event: row }
}

/** Webhook channels, the events they reported and every delivery they received. */
export const channelStore = {
  list: async (): Promise<ChannelRecord[]> =>
    (await sql<Row[]>`SELECT * FROM channel WHERE source = 'webhook' ORDER BY created_at, id`).map(toRecord),
  get: async (id: string): Promise<ChannelRecord | undefined> => {
    const [row] = await sql<Row[]>`SELECT * FROM channel WHERE id = ${id} AND source = 'webhook'`
    return row && toRecord(row)
  },
  create: async (channel: NewChannel): Promise<ChannelRecord> => {
    const [row] = await sql<Row[]>`INSERT INTO channel (id, name, preset, secret, mapping,
        created_at, updated_at, secret_pending)
      VALUES (${channel.id}, ${channel.name}, ${channel.preset}, ${seal(channel.id, channel.secret)},
        ${JSON.stringify(channel.mapping)}, ${channel.created_at}, ${channel.created_at}, ${channel.secret_pending})
      RETURNING *`
    if (row === undefined) {
      throw new Error('Channel was not created')
    }
    return toRecord(row)
  },
  update: async (id: string, change: ChannelChange, at: string): Promise<ChannelRecord | undefined> => {
    const mapping = change.mapping === undefined ? null : JSON.stringify(change.mapping)
    const [row] = await sql<Row[]>`UPDATE channel SET name = COALESCE(${change.name ?? null}, name),
        mapping = COALESCE(${mapping}, mapping),
        updated_at = ${at}
      WHERE id = ${id} RETURNING *`
    return row && toRecord(row)
  },
  rotate: async (
    id: string,
    secret: string,
    pending: ChannelSecretPending | null,
    at: string,
  ): Promise<ChannelRecord | undefined> => {
    const [row] = await sql<Row[]>`UPDATE channel SET secret = ${seal(id, secret)}, secret_rotated_at = ${at},
        secret_pending = ${pending}, updated_at = ${at}
      WHERE id = ${id} RETURNING *`
    return row && toRecord(row)
  },
  /** Takes the one reveal a secret waiting for the user allows; undefined once it was taken. */
  takeReveal: async (id: string): Promise<ChannelRecord | undefined> => {
    const [row] = await sql<Row[]>`UPDATE channel SET secret_pending = NULL
      WHERE id = ${id} AND secret_pending = 'reveal' RETURNING *`
    return row && toRecord(row)
  },
  remove: async (id: string): Promise<boolean> => (await sql`DELETE FROM channel WHERE id = ${id}`).count > 0,
  /** Whether a channel of either source has this id, and which source. */
  sourceOf: async (id: string): Promise<ChannelSource | undefined> => {
    const [row] = await sql<{ source: ChannelSource }[]>`SELECT source FROM channel WHERE id = ${id}`
    return row?.source
  },
  /** Seals secrets stored in the clear by earlier versions; returns how many it sealed. */
  sealLegacySecrets: async (): Promise<number> => {
    const rows = await sql<Pick<Row, 'id' | 'secret'>[]>`SELECT id, secret FROM channel WHERE source = 'webhook'`
    const legacy = rows.filter((row) => !isSealed(row.secret))
    for (const row of legacy) {
      await sql`UPDATE channel SET secret = ${seal(row.id, row.secret)} WHERE id = ${row.id} AND secret = ${row.secret}`
    }
    return legacy.length
  },
  /** Writes sealed secrets back in the clear, for a rollback; returns how many it wrote. */
  unsealSecrets: async (): Promise<number> => {
    const rows = await sql<Row[]>`SELECT * FROM channel WHERE source = 'webhook'`
    const sealed = rows.filter((row) => isSealed(row.secret))
    for (const row of sealed) {
      const plain = storeBox().open(row.secret, secretContext(row.id))
      await sql`UPDATE channel SET secret = ${plain} WHERE id = ${row.id} AND secret = ${row.secret}`
    }
    return sealed.length
  },

  /**
   * Claims a delivery id for the window and stores its event, in one transaction, so a retry of a
   * delivery that failed half way is not taken for a duplicate. Without a claim it only stores.
   */
  accept: async (
    channel: string,
    delivery: { id: string; since: string } | null,
    draft: ChannelEventDraft,
    at: string,
  ): Promise<Accepted> =>
    transaction(async (tx) => {
      if (delivery === null) {
        return recordEvent(tx, channel, draft, at)
      }
      await tx`DELETE FROM channel_delivery_seen WHERE channel = ${channel} AND seen_at < ${delivery.since}`
      const claimed = await tx`INSERT INTO channel_delivery_seen (channel, delivery_id, seen_at)
        VALUES (${channel}, ${delivery.id}, ${at}) ON CONFLICT (channel, delivery_id) DO NOTHING RETURNING 1`
      if (claimed.count === 0) {
        return { kind: 'duplicate' }
      }
      return recordEvent(tx, channel, draft, at)
    }),
  /** Records one delivery and keeps only the newest DELIVERIES_KEPT per channel. */
  delivered: async (delivery: NewDelivery): Promise<void> => {
    await sql`INSERT INTO channel_delivery (channel, received_at, status, http_status, reason, delivery_id,
        event_id, excerpt, routes)
      VALUES (${delivery.channel}, ${delivery.received_at}, ${delivery.status}, ${delivery.http_status},
        ${delivery.reason}, ${delivery.delivery_id}, ${delivery.event_id ?? null}, ${delivery.excerpt ?? ''},
        ${JSON.stringify(delivery.routes ?? [])})`
    await sql`DELETE FROM channel_delivery WHERE channel = ${delivery.channel} AND id < (
        SELECT min(id) FROM (SELECT id FROM channel_delivery WHERE channel = ${delivery.channel}
          ORDER BY id DESC LIMIT ${DELIVERIES_KEPT}) AS kept)`
  },
  deliveries: async (channel: string, limit: number): Promise<ChannelDelivery[]> =>
    (
      await sql<DeliveryRow[]>`SELECT * FROM channel_delivery WHERE channel = ${channel}
        ORDER BY id DESC LIMIT ${limit}`
    ).map((row) => ({ ...row, routes: JSON.parse(row.routes) as ChannelRoute[] })),
  recent: async (channel: string, limit: number): Promise<ChannelEvent[]> => [
    ...(await sql<ChannelEvent[]>`SELECT * FROM channel_event WHERE channel = ${channel} ORDER BY id DESC
      LIMIT ${limit}`),
  ],
}
