import {
  EA_SETTINGS_DEFAULT,
  type EaHistoryEntry,
  type EaHistoryPage,
  type EaLlmMessage,
  type EaNotice,
  type EaSettings,
} from '@seti/shared'
import { now, sql, transaction, type Db } from '../db.js'
import { markReply, type AppendBatch } from './ea-replies.js'

export type HistoryRecord = Omit<EaHistoryEntry, 'message'> & { message: string }

type SettingsRecord = Omit<EaSettings, 'wake_enabled'> & { wake_enabled: number }

export const toEntry = (r: HistoryRecord): EaHistoryEntry => ({
  ...r,
  message: JSON.parse(r.message) as EaLlmMessage,
})

/** Inbox entries in a page carry the item they delivered, so the chat can show it. */
async function withNotices(entries: EaHistoryEntry[]): Promise<EaHistoryEntry[]> {
  const ids = entries.filter((entry) => entry.kind === 'inbox').map((entry) => entry.id)
  if (ids.length === 0) {
    return entries
  }
  const rows = await sql<(EaNotice & { entry_id: number })[]>`SELECT entry_id, kind, event, title, body, url,
    severity, source FROM ea_inbox WHERE entry_id = ANY(${ids})`
  const notices = new Map(rows.map(({ entry_id, ...notice }) => [entry_id, notice]))
  return entries.map((entry) => (entry.kind === 'inbox' ? { ...entry, notice: notices.get(entry.id) ?? null } : entry))
}

/** Held by every write, so batches from a call and the chat never interleave their ids. */
const EA_HISTORY_LOCK = 7_412_001

export const lockHistory = async (db: Db) => db`SELECT pg_advisory_xact_lock(${EA_HISTORY_LOCK})`

const getEntry = async (db: Db, id: number) =>
  (await db<HistoryRecord[]>`SELECT * FROM ea_history WHERE id = ${id}`).at(0)

export async function insertEntry(
  db: Db,
  kind: EaHistoryEntry['kind'],
  message: EaLlmMessage,
  throughId: number | null = null,
) {
  const [row] = await db<{ id: number }[]>`INSERT INTO ea_history (kind, message, through_id, created_at)
    VALUES (${kind}, ${JSON.stringify(message)}, ${throughId}, ${now()}) RETURNING id`
  if (row === undefined) {
    throw new Error('EA history entry was not recorded')
  }
  return row.id
}

/** The EA's one conversation across calls, with compaction summaries in line. */
export const eaHistory = {
  /** The newest `limit` entries before entry `before`, or the newest of all, oldest first. */
  page: async (limit: number, before?: number): Promise<EaHistoryPage> => {
    const rows = await sql<HistoryRecord[]>`SELECT * FROM (SELECT * FROM ea_history
      WHERE id < ${before ?? Number.MAX_SAFE_INTEGER} ORDER BY id DESC LIMIT ${limit + 1}) AS newest ORDER BY id`
    return { entries: await withNotices(rows.slice(-limit).map(toEntry)), has_older: rows.length > limit }
  },
  /** What the bot loads into its LLM context: the latest summary, then every entry after it. */
  context: async (): Promise<EaHistoryPage> => {
    const [summary] = await sql<HistoryRecord[]>`SELECT * FROM ea_history WHERE kind = 'summary'
      ORDER BY id DESC LIMIT 1`
    const rows = await sql<HistoryRecord[]>`SELECT * FROM ea_history
      WHERE id > ${summary?.through_id ?? 0} AND kind <> 'summary' ORDER BY id`
    return { entries: [...(summary ? [summary] : []), ...rows].map(toEntry), has_older: false }
  },
  append: async (input: AppendBatch): Promise<number[]> =>
    transaction(async (tx) => {
      await lockHistory(tx)
      const ids: number[] = []
      for (const entry of input.entries) {
        ids.push(await insertEntry(tx, entry.kind, entry.message))
      }
      await markReply(tx, ids, input)
      return ids
    }),
  /** Null when `throughId` names no entry, as after the history was cleared. */
  summarize: async (summary: string, throughId: number): Promise<EaHistoryEntry | null> =>
    transaction(async (tx) => {
      await lockHistory(tx)
      if ((await getEntry(tx, throughId)) === undefined) {
        return null
      }
      const record = await getEntry(tx, await insertEntry(tx, 'summary', { role: 'user', content: summary }, throughId))
      return record ? toEntry(record) : null
    }),
  clear: async (): Promise<number> =>
    transaction(async (tx) => {
      await lockHistory(tx)
      return (await tx`DELETE FROM ea_history`).count
    }),
}

export const eaSettings = {
  get: async (): Promise<EaSettings> => {
    const [record] = await sql<SettingsRecord[]>`SELECT wake_enabled, wake_phrase, keep_awake_seconds, join_on_open,
      form_of_address, updated_at FROM ea_settings WHERE id = 1`
    return record ? { ...record, wake_enabled: record.wake_enabled === 1 } : EA_SETTINGS_DEFAULT
  },
  save: async (input: Omit<EaSettings, 'updated_at'>): Promise<EaSettings> => {
    await sql`INSERT INTO ea_settings (id, wake_enabled, wake_phrase, keep_awake_seconds, join_on_open,
        form_of_address, updated_at)
      VALUES (1, ${input.wake_enabled ? 1 : 0}, ${input.wake_phrase}, ${input.keep_awake_seconds},
        ${input.join_on_open}, ${input.form_of_address}, ${now()})
      ON CONFLICT (id) DO UPDATE SET wake_enabled = excluded.wake_enabled, wake_phrase = excluded.wake_phrase,
        keep_awake_seconds = excluded.keep_awake_seconds, join_on_open = excluded.join_on_open,
        form_of_address = excluded.form_of_address, updated_at = excluded.updated_at`
    return eaSettings.get()
  },
}
