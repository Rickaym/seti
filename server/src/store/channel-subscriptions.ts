import type { ChannelEaMode, ChannelSubscription, ChannelTarget } from '@seti/shared'
import { sql } from '../db.js'

type Row = Omit<ChannelSubscription, 'events'> & { events: string | null }

const SELECT = sql`SELECT s.id, s.channel_id, c.name AS channel_name, c.preset, s.target, s.task_id,
    t.title AS task_title, (t.archived_at IS NOT NULL) AS task_archived, s.events, s.mode, s.created_at
  FROM channel_subscription s
  JOIN channel c ON c.id = s.channel_id
  LEFT JOIN task t ON t.id = s.task_id`

const toSubscription = (row: Row): ChannelSubscription => ({
  ...row,
  events: row.events === null ? null : (JSON.parse(row.events) as string[]),
})

const eventsText = (events: readonly string[] | null) => (events === null ? null : JSON.stringify(events))

export interface NewSubscription {
  channel_id: string
  target: ChannelTarget
  task_id: string | null
  events: readonly string[] | null
  mode?: ChannelEaMode
  created_at: string
}

export const channelSubscriptions = {
  forChannel: async (channelId: string): Promise<ChannelSubscription[]> =>
    (await sql<Row[]>`${SELECT} WHERE s.channel_id = ${channelId} ORDER BY s.target, s.id`).map(toSubscription),
  forTask: async (taskId: string): Promise<ChannelSubscription[]> =>
    (await sql<Row[]>`${SELECT} WHERE s.task_id = ${taskId} ORDER BY c.name, s.id`).map(toSubscription),
  forEa: async (): Promise<ChannelSubscription[]> =>
    (await sql<Row[]>`${SELECT} WHERE s.target = 'ea' ORDER BY c.name, s.id`).map(toSubscription),
  eaChannelIds: async (): Promise<Set<string>> =>
    new Set(
      (await sql<{ channel_id: string }[]>`SELECT channel_id FROM channel_subscription WHERE target = 'ea'`).map(
        (row) => row.channel_id,
      ),
    ),
  get: async (id: number): Promise<ChannelSubscription | undefined> => {
    const [row] = await sql<Row[]>`${SELECT} WHERE s.id = ${id}`
    return row && toSubscription(row)
  },
  /** Undefined when the channel already has this subscriber. */
  add: async (sub: NewSubscription): Promise<ChannelSubscription | undefined> => {
    const [row] = await sql<{ id: number }[]>`INSERT INTO channel_subscription
        (channel_id, target, task_id, events, mode, created_at)
      VALUES (${sub.channel_id}, ${sub.target}, ${sub.task_id}, ${eventsText(sub.events)}, ${sub.mode ?? 'report'},
        ${sub.created_at})
      ON CONFLICT DO NOTHING RETURNING id`
    return row === undefined ? undefined : channelSubscriptions.get(row.id)
  },
  setEvents: async (id: number, events: readonly string[] | null): Promise<ChannelSubscription | undefined> => {
    await sql`UPDATE channel_subscription SET events = ${eventsText(events)} WHERE id = ${id}`
    return channelSubscriptions.get(id)
  },
  setMode: async (id: number, mode: ChannelEaMode): Promise<ChannelSubscription | undefined> => {
    await sql`UPDATE channel_subscription SET mode = ${mode} WHERE id = ${id}`
    return channelSubscriptions.get(id)
  },
  remove: async (id: number): Promise<boolean> =>
    (await sql`DELETE FROM channel_subscription WHERE id = ${id}`).count > 0,
}
