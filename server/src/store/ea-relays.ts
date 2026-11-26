import type { EaInboxKind, EaRelay, TeamDeliveryMode } from '@seti/shared'
import { sql } from '../db.js'
import { taskInputs } from './inputs.js'

/** A stored relay with its agent's title and how the message reached it. */
export interface RelayRow {
  id: number
  item_id: number | null
  entry_id: number | null
  task_id: string | null
  title: string
  message_id: number | null
  mode: TeamDeliveryMode
  created_at: string
  taken_back_at: string | null
}

const SELECT = sql`SELECT r.id, r.item_id, i.entry_id, r.task_id, COALESCE(t.title, '') AS title, r.message_id,
    COALESCE((SELECT d.mode FROM team_delivery d WHERE d.message_id = r.message_id AND d.task_id = r.task_id
      ORDER BY d.id DESC LIMIT 1), 'held') AS mode, r.created_at, r.taken_back_at
  FROM ea_relay r
  LEFT JOIN ea_inbox i ON i.id = r.item_id
  LEFT JOIN task t ON t.id = r.task_id`

/** Narrows a count to one agent's relays, or to none for all of them. */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
const toAgent = (taskId: string | null) => (taskId === null ? sql`` : sql`AND task_id = ${taskId}`)

/** What a relay checks of an inbox item, all of it set by Seti but the title and body. */
export interface RelayItem {
  id: number
  kind: EaInboxKind
  title: string
  body: string
  url: string | null
  source: string
  task_id: string | null
  message_id: number | null
  channel_id: string | null
}

/** Relays the EA sent of inbox items: one per item, counted for the hourly limits. */
export const eaRelays = {
  item: async (id: number): Promise<RelayItem | undefined> =>
    (
      await sql<RelayItem[]>`SELECT id, kind, title, body, url, source, task_id, message_id, channel_id
        FROM ea_inbox WHERE id = ${id}`
    ).at(0),
  /** Undefined when the item already has a relay. */
  add: async (relay: { item_id: number; task_id: string; created_at: string }): Promise<number | undefined> =>
    (
      await sql<{ id: number }[]>`INSERT INTO ea_relay (item_id, task_id, created_at)
        VALUES (${relay.item_id}, ${relay.task_id}, ${relay.created_at})
        ON CONFLICT (item_id) DO NOTHING RETURNING id`
    ).at(0)?.id,
  setMessage: async (id: number, messageId: number): Promise<void> => {
    await sql`UPDATE ea_relay SET message_id = ${messageId} WHERE id = ${id}`
  },
  remove: async (id: number): Promise<void> => {
    await sql`DELETE FROM ea_relay WHERE id = ${id}`
  },
  /** Relays since `since`, to one agent or to all. */
  countSince: async (since: string, taskId: string | null = null): Promise<number> => {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ea_relay
      WHERE created_at >= ${since} ${toAgent(taskId)}`
    return row?.n ?? 0
  },
  /** The oldest relay time since `since`, to one agent or to all; the limit resets an hour after it. */
  oldestSince: async (since: string, taskId: string | null = null): Promise<string | null> => {
    const [row] = await sql<{ at: string | null }[]>`SELECT min(created_at) AS at FROM ea_relay
      WHERE created_at >= ${since} ${toAgent(taskId)}`
    return row?.at ?? null
  },
  get: async (id: number): Promise<RelayRow | undefined> => (await sql<RelayRow[]>`${SELECT} WHERE r.id = ${id}`).at(0),
  /** The relays of the items these inbox entries delivered, oldest first. */
  forEntries: async (entryIds: readonly number[]): Promise<RelayRow[]> =>
    sql<RelayRow[]>`${SELECT} WHERE i.entry_id = ANY(${[...entryIds]}) ORDER BY r.id`,
  /** Marks the relay taken back; false when it already was. */
  takeBack: async (id: number, at: string): Promise<boolean> =>
    (await sql`UPDATE ea_relay SET taken_back_at = ${at} WHERE id = ${id} AND taken_back_at IS NULL`).count > 0,
  /** The name the user gave a channel of any source. */
  channelName: async (id: string): Promise<string | undefined> =>
    (await sql<{ name: string }[]>`SELECT name FROM channel WHERE id = ${id}`).at(0)?.name,
  /** Agents with this pull request linked, newest work first. */
  prTasks: async (prUrl: string): Promise<string[]> =>
    (
      await sql<{ task_id: string }[]>`SELECT p.task_id FROM task_pr p JOIN task t ON t.id = p.task_id
        WHERE p.pr_url = ${prUrl} ORDER BY t.updated_at DESC`
    ).map((row) => row.task_id),
}

/** A relay as the chat shows it; pending while its message still waits for the agent. */
export async function relayView(row: RelayRow): Promise<EaRelay> {
  const waiting =
    row.task_id === null || row.message_id === null || row.taken_back_at !== null
      ? false
      : (await taskInputs.waitingTeamMessages(row.task_id, [row.message_id])).has(row.message_id)
  return {
    id: row.id,
    item_id: row.item_id,
    task_id: row.task_id,
    title: row.title,
    message_id: row.message_id,
    mode: row.mode,
    pending: waiting,
    taken_back: row.taken_back_at !== null,
    created_at: row.created_at,
  }
}

/** The relays of each of these inbox entries, oldest first. */
export async function relaysByEntry(entryIds: readonly number[]): Promise<Map<number, EaRelay[]>> {
  const byEntry = new Map<number, EaRelay[]>()
  for (const row of await eaRelays.forEntries(entryIds)) {
    if (row.entry_id !== null) {
      byEntry.set(row.entry_id, [...(byEntry.get(row.entry_id) ?? []), await relayView(row)])
    }
  }
  return byEntry
}
