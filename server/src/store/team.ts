import type {
  TeamAuthorKind,
  TeamDeliveryMode,
  TeamMention,
  TeamMessage,
  TeamRecipientKind,
  TeamWindow,
} from '@seti/shared'
import { now, sql } from '../db.js'
import { errorCode } from '../pg.js'

interface MemberRecord {
  task_id: string
  handle: string
  muted: number
  updated_at: string
}

export interface MemberRow {
  task_id: string
  handle: string
  muted: boolean
}

type MessageRecord = Omit<TeamMessage, 'id' | 'mentions'> & { id: string | number; mentions: string }

const toMember = (r: MemberRecord): MemberRow => ({ task_id: r.task_id, handle: r.handle, muted: r.muted === 1 })

const toMessage = (r: MessageRecord): TeamMessage => ({
  ...r,
  id: Number(r.id),
  mentions: JSON.parse(r.mentions) as TeamMention[],
})

const UNIQUE_VIOLATION = '23505'

export const teamMembers = {
  list: async (): Promise<MemberRow[]> =>
    (await sql<MemberRecord[]>`SELECT * FROM team_member ORDER BY handle`).map(toMember),
  get: async (taskId: string): Promise<MemberRow | undefined> => {
    const [row] = await sql<MemberRecord[]>`SELECT * FROM team_member WHERE task_id = ${taskId}`
    return row && toMember(row)
  },
  byHandles: async (handles: readonly string[]): Promise<MemberRow[]> =>
    handles.length === 0
      ? []
      : (await sql<MemberRecord[]>`SELECT * FROM team_member WHERE handle = ANY(${[...handles]})`).map(toMember),
  /** Gives a task without a handle this one; false when another task holds it. */
  claim: async (taskId: string, handle: string): Promise<boolean> => {
    try {
      const result = await sql`INSERT INTO team_member (task_id, handle, muted, updated_at)
        VALUES (${taskId}, ${handle}, 0, ${now()}) ON CONFLICT (task_id) DO NOTHING`
      return result.count > 0
    } catch (e) {
      if (errorCode(e) === UNIQUE_VIOLATION) {
        return false
      }
      throw e
    }
  },
  /** False when another task holds the handle. */
  setHandle: async (taskId: string, handle: string): Promise<boolean> => {
    try {
      await sql`UPDATE team_member SET handle = ${handle}, updated_at = ${now()} WHERE task_id = ${taskId}`
      return true
    } catch (e) {
      if (errorCode(e) === UNIQUE_VIOLATION) {
        return false
      }
      throw e
    }
  },
  setMuted: async (taskId: string, muted: boolean) => {
    await sql`UPDATE team_member SET muted = ${muted ? 1 : 0}, updated_at = ${now()} WHERE task_id = ${taskId}`
  },
}

export interface NewTeamMessage {
  author_kind: TeamAuthorKind
  author_task_id: string | null
  author_handle: string | null
  author_mod_id?: string | null
  text: string
  mentions: TeamMention[]
  to_kind?: TeamRecipientKind | null
  to_task_id?: string | null
  to_handle?: string | null
}

/**
 * Who reads the chat: the user sees every message, the EA and agents public ones and their own
 * direct ones, and a public reader, such as a summary both the EA and agents read, public ones.
 */
export type DirectParties = Pick<
  TeamMessage,
  'author_kind' | 'author_task_id' | 'author_mod_id' | 'to_kind' | 'to_task_id'
>

export type TeamReader = { kind: 'user' } | { kind: 'public' } | { kind: 'ea' } | { kind: 'task'; taskId: string }

export const USER_READER: TeamReader = { kind: 'user' }

/** The messages the reader may see, as a condition on team_message rows. */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- an unrun fragment of a query
export function visibleTo(reader: TeamReader) {
  switch (reader.kind) {
    case 'user':
      return sql`TRUE`
    case 'public':
      return sql`to_kind IS NULL`
    case 'ea':
      return sql`(to_kind IS NULL OR to_kind = 'ea' OR author_kind = 'ea')`
    case 'task':
      return sql`(to_kind IS NULL OR to_task_id = ${reader.taskId} OR author_task_id = ${reader.taskId})`
  }
}

/** Whether the reader may see the message, as visibleTo decides in SQL. */
export function canRead(reader: TeamReader, message: TeamMessage): boolean {
  if (message.to_kind === null || reader.kind === 'user') {
    return true
  }
  if (reader.kind === 'public') {
    return false
  }
  if (reader.kind === 'ea') {
    return message.to_kind === 'ea' || message.author_kind === 'ea'
  }
  return message.to_task_id === reader.taskId || message.author_task_id === reader.taskId
}

export const teamMessages = {
  insert: async (message: NewTeamMessage): Promise<TeamMessage> => {
    const [row] = await sql<MessageRecord[]>`INSERT INTO team_message
        (author_kind, author_task_id, author_handle, author_mod_id, text, mentions, to_kind, to_task_id, to_handle,
          created_at)
      VALUES (${message.author_kind}, ${message.author_task_id}, ${message.author_handle},
        ${message.author_mod_id ?? null}, ${message.text}, ${JSON.stringify(message.mentions)},
        ${message.to_kind ?? null}, ${message.to_task_id ?? null}, ${message.to_handle ?? null}, ${now()})
      RETURNING *`
    if (row === undefined) {
      throw new Error('Team message was not recorded')
    }
    return toMessage(row)
  },
  /** Who wrote each direct message and whom it went to, by message id. */
  parties: async (ids: readonly number[]): Promise<Map<number, DirectParties>> => {
    if (ids.length === 0) {
      return new Map()
    }
    const rows = await sql<(DirectParties & { id: string | number })[]>`SELECT id, author_kind, author_task_id,
        author_mod_id, to_kind, to_task_id FROM team_message WHERE id = ANY(${[...ids]}) AND to_kind IS NOT NULL`
    return new Map(rows.map(({ id, ...parties }) => [Number(id), parties]))
  },
  get: async (id: number): Promise<TeamMessage | undefined> => {
    const [row] = await sql<MessageRecord[]>`SELECT * FROM team_message WHERE id = ${id}`
    return row && toMessage(row)
  },
  /** Messages the reader sees after `after`, oldest first, or the newest `limit` without it. */
  list: async (reader: TeamReader, limit: number, after?: number): Promise<TeamMessage[]> => {
    const seen = visibleTo(reader)
    const rows =
      after === undefined
        ? await sql<MessageRecord[]>`SELECT * FROM (SELECT * FROM team_message WHERE ${seen}
            ORDER BY id DESC LIMIT ${limit}) AS newest ORDER BY id`
        : await sql<MessageRecord[]>`SELECT * FROM team_message WHERE ${seen} AND id > ${after}
            ORDER BY id LIMIT ${limit}`
    return rows.map(toMessage)
  },
  /** The `limit` messages the reader sees just before `before`, oldest first. */
  before: async (reader: TeamReader, limit: number, before: number): Promise<TeamMessage[]> =>
    (
      await sql<MessageRecord[]>`SELECT * FROM (SELECT * FROM team_message WHERE ${visibleTo(reader)}
        AND id < ${before} ORDER BY id DESC LIMIT ${limit}) AS page ORDER BY id`
    ).map(toMessage),
  /** About `limit` messages the reader sees around `id`, oldest first, and if more lie either side. */
  around: async (reader: TeamReader, limit: number, id: number): Promise<TeamWindow> => {
    const half = Math.floor(limit / 2)
    const seen = visibleTo(reader)
    const [older, newer] = await Promise.all([
      sql<MessageRecord[]>`SELECT * FROM team_message WHERE ${seen} AND id < ${id}
        ORDER BY id DESC LIMIT ${half + 1}`,
      sql<MessageRecord[]>`SELECT * FROM team_message WHERE ${seen} AND id >= ${id}
        ORDER BY id LIMIT ${limit - half + 1}`,
    ])
    return {
      messages: [...older.slice(0, half).reverse(), ...newer.slice(0, limit - half)].map(toMessage),
      has_older: older.length > half,
      has_newer: newer.length > limit - half,
    }
  },
  /** How many messages the two tasks sent each other with a mention since `since`. */
  exchangesSince: async (a: string, b: string, since: string): Promise<number> => {
    const [row] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM team_message
      WHERE created_at >= ${since} AND (
        (author_task_id = ${a} AND mentions::jsonb @> ${JSON.stringify([{ task_id: b }])}::text::jsonb)
        OR (author_task_id = ${b} AND mentions::jsonb @> ${JSON.stringify([{ task_id: a }])}::text::jsonb))`
    return row?.count ?? 0
  },
  /** Whether any message mentioned the task by its handle after `since`. */
  mentionsAfter: async (taskId: string, since: string): Promise<boolean> =>
    (
      await sql`SELECT 1 FROM team_message WHERE created_at > ${since}
        AND mentions::jsonb @> ${JSON.stringify([{ task_id: taskId }])}::text::jsonb LIMIT 1`
    ).length > 0,
}

export interface NewTeamDelivery {
  message_id: number
  task_id: string
  author_kind: TeamAuthorKind
  mode: TeamDeliveryMode
  reason: string | null
}

interface DeliveryRecord {
  handle: string
  mode: TeamDeliveryMode
  reason: string | null
}

export const teamDeliveries = {
  record: async (d: NewTeamDelivery) => {
    await sql`INSERT INTO team_delivery (message_id, task_id, author_kind, mode, reason, created_at)
      VALUES (${d.message_id}, ${d.task_id}, ${d.author_kind}, ${d.mode}, ${d.reason}, ${now()})`
  },
  /** What each of the messages did for the tasks it reached, with their current handles. */
  forMessages: async (ids: readonly number[]): Promise<(DeliveryRecord & { message_id: number })[]> =>
    ids.length === 0
      ? []
      : (
          await sql<(DeliveryRecord & { message_id: string | number })[]>`SELECT d.message_id,
              COALESCE(m.handle, d.task_id) AS handle, d.mode, d.reason
            FROM team_delivery d LEFT JOIN team_member m ON m.task_id = d.task_id
            WHERE d.message_id = ANY(${[...ids]}) ORDER BY d.message_id, d.created_at`
        ).map((row) => ({ ...row, message_id: Number(row.message_id) })),
  /** Messages from agents and mods that reached the task on their own since `since`. */
  fromAgentsSince: async (taskId: string, since: string): Promise<number> => {
    const [row] = await sql<{ count: string }[]>`SELECT count(*) AS count FROM team_delivery
      WHERE task_id = ${taskId} AND author_kind IN ('task', 'mod') AND mode IN ('now', 'next', 'start')
        AND created_at >= ${since}`
    return Number(row?.count ?? 0)
  },
}
