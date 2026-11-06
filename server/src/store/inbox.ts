import type {
  AttentionRoute,
  EaHistoryEntry,
  EaInboxDelivered,
  EaInboxItem,
  EaInboxKind,
  EaInboxUnread,
  EaInboxVia,
  EaNotice,
  EaWatch,
} from '@seti/shared'
import { sql, transaction } from '../db.js'
import { eaReplies } from './ea-replies.js'
import { insertEntry, lockHistory, toEntry, type HistoryRecord } from './ea.js'

type ItemRecord = EaInboxItem & { depth: number; entry_id: number | null; coalesce_key: string | null }

export interface NewInboxItem extends EaNotice {
  task_id: string | null
  due_at: string
  created_at: string
  timezone?: string | null
  depth?: number
  urgent?: boolean
  act?: boolean
  message_id?: number | null
  /** An undelivered item with the same key takes this one's place instead of a new row. */
  coalesce_key?: string | null
}

const FOLLOWUP_KINDS: readonly EaInboxKind[] = ['followup', 'reminder']

const toItem = ({ depth: _depth, entry_id: _entry, coalesce_key: _key, ...item }: ItemRecord): EaInboxItem => item

/** Items waiting for the EA, the follow-ups it scheduled, and what the user has seen. */
export const eaInbox = {
  /** Adds the item, or updates in place the undelivered one with its coalesce key. */
  add: async (item: NewInboxItem): Promise<EaInboxItem> => {
    const [row] = await sql<ItemRecord[]>`INSERT INTO ea_inbox (kind, event, title, body, url, severity, source,
        task_id, timezone, depth, urgent, act, message_id, coalesce_key, due_at, created_at)
      VALUES (${item.kind}, ${item.event}, ${item.title}, ${item.body}, ${item.url}, ${item.severity},
        ${item.source}, ${item.task_id}, ${item.timezone ?? null}, ${item.depth ?? 0}, ${item.urgent ?? false},
        ${item.act ?? false}, ${item.message_id ?? null}, ${item.coalesce_key ?? null}, ${item.due_at},
        ${item.created_at})
      ON CONFLICT (coalesce_key) WHERE delivered_at IS NULL AND cancelled_at IS NULL
      DO UPDATE SET event = excluded.event, title = excluded.title, body = excluded.body, url = excluded.url,
        severity = excluded.severity, source = excluded.source, urgent = excluded.urgent
      RETURNING *`
    if (row === undefined) {
      throw new Error('Inbox item was not recorded')
    }
    return toItem(row)
  },
  get: async (id: number): Promise<EaInboxItem | undefined> => {
    const [row] = await sql<ItemRecord[]>`SELECT * FROM ea_inbox WHERE id = ${id}`
    return row && toItem(row)
  },
  /** How many follow-ups deep an item sits: 0 for one the user asked for. */
  depth: async (id: number): Promise<number | undefined> =>
    (await sql<{ depth: number }[]>`SELECT depth FROM ea_inbox WHERE id = ${id}`).at(0)?.depth,
  /** Follow-ups and reminders not yet due or delivered, soonest first. */
  scheduled: async (): Promise<EaInboxItem[]> =>
    (
      await sql<ItemRecord[]>`SELECT * FROM ea_inbox WHERE kind IN ${sql(FOLLOWUP_KINDS)}
        AND delivered_at IS NULL AND cancelled_at IS NULL ORDER BY due_at, id`
    ).map(toItem),
  /** Cancels a follow-up or reminder that has not gone out; undefined when there is none. */
  cancel: async (id: number, at: string): Promise<EaInboxItem | undefined> => {
    const [row] = await sql<ItemRecord[]>`UPDATE ea_inbox SET cancelled_at = ${at}
      WHERE id = ${id} AND kind IN ${sql(FOLLOWUP_KINDS)} AND delivered_at IS NULL AND cancelled_at IS NULL
      RETURNING *`
    return row && toItem(row)
  },
  /** Items due by `at` that nobody has delivered, oldest first, optionally only of some kinds. */
  due: async (at: string, limit: number, kinds: readonly EaInboxKind[] | null = null): Promise<EaInboxItem[]> =>
    (
      await sql<ItemRecord[]>`SELECT * FROM ea_inbox WHERE delivered_at IS NULL AND cancelled_at IS NULL
        AND due_at <= ${at} ${kinds === null ? sql`` : sql`AND kind IN ${sql(kinds)}`}
        ORDER BY due_at, id LIMIT ${limit}`
    ).map(toItem),
  /**
   * Marks the items delivered and adds each to the EA history as an inbox entry, in one
   * transaction under the history lock. An item goes out once: those already delivered,
   * cancelled or not yet due are left out of the answer.
   */
  deliver: async (
    { ids, via }: { ids: readonly number[]; via: EaInboxVia },
    at: string,
    text: (item: EaInboxItem) => string,
  ): Promise<EaInboxDelivered> =>
    transaction(async (tx) => {
      await lockHistory(tx)
      const seen = via === 'voice' ? at : null
      const rows = await tx<ItemRecord[]>`UPDATE ea_inbox SET delivered_at = ${at}, delivered_via = ${via},
          acknowledged_at = ${seen}
        WHERE id = ANY(${[...ids]}) AND delivered_at IS NULL AND cancelled_at IS NULL AND due_at <= ${at}
        RETURNING *`
      const order = (a: EaInboxItem, b: EaInboxItem) => {
        const byDue = a.due_at.localeCompare(b.due_at)
        return byDue === 0 ? a.id - b.id : byDue
      }
      const items = rows.map(toItem).sort(order)
      const entries: EaHistoryEntry[] = []
      for (const item of items) {
        const id = await insertEntry(tx, 'inbox', { role: 'developer', content: text(item) })
        await tx`UPDATE ea_inbox SET entry_id = ${id} WHERE id = ${item.id}`
        const [record] = await tx<HistoryRecord[]>`SELECT * FROM ea_history WHERE id = ${id}`
        if (record !== undefined) {
          entries.push({ ...toEntry(record), notice: item })
        }
      }
      return { items, entries }
    }),
  /** Records the surface that carried each item, and marks unseen those a toast shows. */
  route: async (routes: ReadonlyMap<number, AttentionRoute>, toast: readonly number[]): Promise<void> => {
    await transaction(async (tx) => {
      for (const [id, route] of routes) {
        await tx`UPDATE ea_inbox SET route = ${route} WHERE id = ${id}`
      }
      await eaReplies.markInbox(tx, toast)
    })
  },
  /** Items delivered after `since` that waited for the brief or went out as a push, newest first. */
  briefed: async (since: string, limit: number): Promise<EaInboxItem[]> =>
    (
      await sql<ItemRecord[]>`SELECT * FROM ea_inbox WHERE delivered_at > ${since} AND route IN ('digest', 'push')
        ORDER BY delivered_at DESC, id DESC LIMIT ${limit}`
    ).map(toItem),
  unread: async (at: string): Promise<EaInboxUnread> => {
    const [row] = await sql<{ unread: number; waiting: number }[]>`SELECT
        COUNT(*) FILTER (WHERE delivered_at IS NOT NULL AND acknowledged_at IS NULL)::int AS unread,
        COUNT(*) FILTER (WHERE delivered_at IS NULL AND cancelled_at IS NULL AND due_at <= ${at})::int AS waiting
      FROM ea_inbox`
    return { unread: row?.unread ?? 0, waiting: row?.waiting ?? 0 }
  },
  /** Marks everything delivered as seen; returns how many were unread. */
  acknowledge: async (at: string): Promise<number> =>
    (
      await sql`UPDATE ea_inbox SET acknowledged_at = ${at}
        WHERE delivered_at IS NOT NULL AND acknowledged_at IS NULL`
    ).count,
}

type WatchRecord = EaWatch

export const eaWatches = {
  /** Watches the task, or updates the note of an existing watch; archived tasks' watches rest. */
  add: async (taskId: string, note: string, at: string): Promise<EaWatch | undefined> => {
    await sql`INSERT INTO ea_watch (task_id, note, created_at) VALUES (${taskId}, ${note}, ${at})
      ON CONFLICT (task_id) DO UPDATE SET note = excluded.note`
    return eaWatches.get(taskId)
  },
  get: async (taskId: string): Promise<EaWatch | undefined> =>
    (
      await sql<WatchRecord[]>`SELECT w.id, w.task_id, t.title AS task_title, w.note, w.created_at
        FROM ea_watch w JOIN task t ON t.id = w.task_id WHERE w.task_id = ${taskId} AND t.archived_at IS NULL`
    ).at(0),
  list: async (): Promise<EaWatch[]> => [
    ...(await sql<WatchRecord[]>`SELECT w.id, w.task_id, t.title AS task_title, w.note, w.created_at
      FROM ea_watch w JOIN task t ON t.id = w.task_id WHERE t.archived_at IS NULL ORDER BY w.id`),
  ],
  /** True when the task was watched. */
  remove: async (taskId: string): Promise<boolean> =>
    (await sql`DELETE FROM ea_watch WHERE task_id = ${taskId}`).count > 0,
}
