import type { EaAssignSkip, EaInboxKind, EaRelay, TeamDeliveryMode } from '@seti/shared'
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
  started: boolean
  running: boolean
}

const SELECT = sql`SELECT r.id, r.item_id, i.entry_id, r.task_id, COALESCE(t.title, '') AS title, r.message_id,
    COALESCE((SELECT d.mode FROM team_delivery d WHERE d.message_id = r.message_id AND d.task_id = r.task_id
      ORDER BY d.id DESC LIMIT 1), 'held') AS mode, r.created_at, r.taken_back_at, r.started,
      COALESCE(t.status = 'running', false) AS running
  FROM ea_relay r
  LEFT JOIN ea_inbox i ON i.id = r.item_id
  LEFT JOIN task t ON t.id = r.task_id`

/** Which relays a count takes: one agent's or all, and only starts when asked. */
export interface RelayScope {
  taskId?: string
  started?: boolean
}

// eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
const toAgent = (taskId: string | undefined) => (taskId === undefined ? sql`` : sql`AND task_id = ${taskId}`)
// eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
const startsOnly = (started: boolean | undefined) => (started === true ? sql`AND started` : sql``)

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
  /** From a channel the user set to act, which lets the EA hand its work to any agent. */
  act: boolean
}

/** Relays the EA sent of inbox items: one per item, counted for the hourly limits. */
export const eaRelays = {
  item: async (id: number): Promise<RelayItem | undefined> =>
    (
      await sql<RelayItem[]>`SELECT id, kind, title, body, url, source, task_id, message_id, channel_id, act
        FROM ea_inbox WHERE id = ${id}`
    ).at(0),
  /** Undefined when the item already has a relay. */
  add: async (relay: {
    item_id: number
    task_id: string | null
    created_at: string
    started?: boolean
  }): Promise<number | undefined> =>
    (
      await sql<{ id: number }[]>`INSERT INTO ea_relay (item_id, task_id, created_at, started)
        VALUES (${relay.item_id}, ${relay.task_id}, ${relay.created_at}, ${relay.started ?? false})
        ON CONFLICT (item_id) DO NOTHING RETURNING id`
    ).at(0)?.id,
  setMessage: async (id: number, messageId: number): Promise<void> => {
    await sql`UPDATE ea_relay SET message_id = ${messageId} WHERE id = ${id}`
  },
  setTask: async (id: number, taskId: string): Promise<void> => {
    await sql`UPDATE ea_relay SET task_id = ${taskId} WHERE id = ${id}`
  },
  remove: async (id: number): Promise<void> => {
    await sql`DELETE FROM ea_relay WHERE id = ${id}`
  },
  /** Relays since `since` in a scope. */
  countSince: async (since: string, scope: RelayScope = {}): Promise<number> => {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ea_relay
      WHERE created_at >= ${since} ${toAgent(scope.taskId)} ${startsOnly(scope.started)}`
    return row?.n ?? 0
  },
  /** The oldest relay time since `since` in a scope; a limit resets one window after it. */
  oldestSince: async (since: string, scope: RelayScope = {}): Promise<string | null> => {
    const [row] = await sql<{ at: string | null }[]>`SELECT min(created_at) AS at FROM ea_relay
      WHERE created_at >= ${since} ${toAgent(scope.taskId)} ${startsOnly(scope.started)}`
    return row?.at ?? null
  },
  get: async (id: number): Promise<RelayRow | undefined> => (await sql<RelayRow[]>`${SELECT} WHERE r.id = ${id}`).at(0),
  /** The relays of the items these inbox entries delivered, oldest first. */
  forEntries: async (entryIds: readonly number[]): Promise<RelayRow[]> =>
    sql<RelayRow[]>`${SELECT} WHERE i.entry_id = ANY(${[...entryIds]}) ORDER BY r.id`,
  /** Marks the relay taken back; false when it already was. */
  takeBack: async (id: number, at: string): Promise<boolean> =>
    (await sql`UPDATE ea_relay SET taken_back_at = ${at} WHERE id = ${id} AND taken_back_at IS NULL`).count > 0,
  /** The channel with this id, else the one channel with this name; undefined when none or several. */
  channelRef: async (ref: string): Promise<string | undefined> => {
    const rows = await sql<{ id: string }[]>`SELECT id FROM channel
      WHERE id = ${ref} OR lower(name) = lower(${ref.replace(/^#/, '')}) ORDER BY (id = ${ref}) DESC LIMIT 2`
    const [first, second] = rows
    return first !== undefined && (second === undefined || first.id === ref) ? first.id : undefined
  },
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
    started: row.started,
    running: row.running,
    created_at: row.created_at,
  }
}

/** Agents and channels the user told the EA to stop assigning to or from. */
export const assignSkips = {
  list: async (): Promise<EaAssignSkip[]> =>
    sql<EaAssignSkip[]>`SELECT s.kind, s.ref, COALESCE(t.title, c.name, s.ref) AS name, s.created_at
      FROM ea_assign_skip s
      LEFT JOIN task t ON s.kind = 'agent' AND t.id = s.ref
      LEFT JOIN channel c ON s.kind = 'channel' AND c.id = s.ref
      ORDER BY s.created_at`,
  /** False when it was there already. */
  add: async (kind: EaAssignSkip['kind'], ref: string, at: string): Promise<boolean> =>
    (
      await sql`INSERT INTO ea_assign_skip (kind, ref, created_at) VALUES (${kind}, ${ref}, ${at})
      ON CONFLICT DO NOTHING`
    ).count > 0,
  /** False when it was not there. */
  remove: async (kind: EaAssignSkip['kind'], ref: string): Promise<boolean> =>
    (await sql`DELETE FROM ea_assign_skip WHERE kind = ${kind} AND ref = ${ref}`).count > 0,
  has: async (kind: EaAssignSkip['kind'], ref: string): Promise<boolean> =>
    (await sql`SELECT 1 FROM ea_assign_skip WHERE kind = ${kind} AND ref = ${ref}`).length > 0,
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
