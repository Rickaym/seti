import {
  AUTO_ARCHIVE_DEFAULTS,
  type ArchivedWorktree,
  type AutoArchiveSettings,
  type TaskArchiveInfo,
  type TaskFilesBundle,
} from '@seti/shared'
import { ArchiveWriter, decodeArchive, type ChunkRef, type StoredMessage } from '../archive-codec.js'
import { now, sql, transaction, type Db } from '../db.js'

/** An archive's index and sizes; the blob stays in the database until a chunk is read. */
export interface ArchiveRecord extends TaskArchiveInfo {
  task_id: string
  chunks: ChunkRef[]
  sha256: string
}

interface ArchiveRow {
  task_id: string
  codec: string
  chunks: string
  row_count: number
  raw_bytes: number
  stored_bytes: number
  table_bytes: number
  sha256: string
  worktrees: string
  files: string | null
  actor: 'user' | 'system'
  archived_at: string
}

const toRecord = (row: ArchiveRow): ArchiveRecord => ({
  task_id: row.task_id,
  codec: row.codec,
  chunks: JSON.parse(row.chunks) as ChunkRef[],
  rows: row.row_count,
  raw_bytes: row.raw_bytes,
  stored_bytes: row.stored_bytes,
  table_bytes: row.table_bytes,
  sha256: row.sha256,
  worktrees: JSON.parse(row.worktrees) as ArchivedWorktree[],
  files: row.files === null ? null : (JSON.parse(row.files) as TaskFilesBundle),
  actor: row.actor,
  archived_at: row.archived_at,
})

const INFO = sql`task_id, codec, chunks, row_count, raw_bytes, stored_bytes, table_bytes, sha256, worktrees, files,
  actor, archived_at`

const READ_BATCH = 2000
const INSERT_BATCH = 1000

/** Heap bytes of the rows by PostgreSQL's measure: columns, tuple header and line pointer. */
async function tableBytes(tx: Db, taskId: string): Promise<number> {
  const [row] = await tx<{ bytes: number }[]>`SELECT COALESCE(SUM(pg_column_size(id) + pg_column_size(task_id)
      + pg_column_size(kind) + pg_column_size(payload) + pg_column_size(outward) + pg_column_size(created_at)
      + 28), 0)::bigint AS bytes
    FROM task_message WHERE task_id = ${taskId}`
  return row?.bytes ?? 0
}

async function encodeTranscript(tx: Db, taskId: string) {
  const writer = new ArchiveWriter()
  for (let after = 0; ;) {
    const rows = await tx<StoredMessage[]>`SELECT id, kind, payload, outward, created_at FROM task_message
      WHERE task_id = ${taskId} AND id > ${after} ORDER BY id LIMIT ${READ_BATCH}`
    const last = rows.at(-1)
    if (last === undefined) {
      break
    }
    await writer.add(rows)
    after = last.id
  }
  return writer.finish()
}

async function insertRows(tx: Db, taskId: string, rows: readonly StoredMessage[]): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const batch = rows.slice(start, start + INSERT_BATCH)
    await tx`INSERT INTO task_message (id, task_id, kind, payload, outward, created_at)
      SELECT id, ${taskId}, kind, payload, outward, created_at FROM unnest(
        ${batch.map((row) => row.id)}::bigint[], ${batch.map((row) => row.kind)}::text[],
        ${batch.map((row) => row.payload)}::text[], ${batch.map((row) => row.outward)}::text[],
        ${batch.map((row) => row.created_at)}::text[]
      ) AS r(id, kind, payload, outward, created_at)`
  }
}

export const taskArchives = {
  /**
   * Moves the task's transcript into one compressed archive and marks it archived, all in one
   * transaction; null when the task is gone or already archived. The rows are decoded and
   * checked against the checksum before they are deleted.
   */
  archive: async (taskId: string, actor: 'user' | 'system'): Promise<ArchiveRecord | null> =>
    transaction(async (tx) => {
      const [task] = await tx<{ archived_at: string | null }[]>`SELECT archived_at FROM task
        WHERE id = ${taskId} FOR UPDATE`
      if (task?.archived_at !== null) {
        return null
      }
      const table = await tableBytes(tx, taskId)
      const encoded = await encodeTranscript(tx, taskId)
      await decodeArchive(encoded)
      const at = now()
      const [row] = await tx<ArchiveRow[]>`INSERT INTO task_archive (task_id, codec, blob, chunks, row_count,
          raw_bytes, stored_bytes, table_bytes, sha256, actor, archived_at)
        VALUES (${taskId}, ${encoded.codec}, ${encoded.blob}, ${JSON.stringify(encoded.chunks)}, ${encoded.rows},
          ${encoded.raw_bytes}, ${encoded.blob.length}, ${table}, ${encoded.sha256}, ${actor}, ${at})
        RETURNING ${INFO}`
      const deleted = await tx`DELETE FROM task_message WHERE task_id = ${taskId}`
      if (row === undefined || deleted.count !== encoded.rows) {
        throw new Error('The transcript changed while it was being archived')
      }
      await tx`UPDATE task SET archived_at = ${at} WHERE id = ${taskId}`
      await tx`UPDATE ea_doc SET archived = 1 WHERE task_id = ${taskId}`
      await tx`UPDATE ea_inbox SET urgent = false WHERE task_id = ${taskId} AND delivered_at IS NULL`
      return toRecord(row)
    }),
  /** Puts the archived rows back with their ids and clears the flag; null when not archived. */
  restore: async (taskId: string): Promise<{ rows: number } | null> =>
    transaction(async (tx) => {
      await tx`SELECT 1 FROM task WHERE id = ${taskId} FOR UPDATE`
      const [archive] = await tx<{ codec: string; blob: Buffer; chunks: string; sha256: string }[]>`SELECT codec,
          blob, chunks, sha256 FROM task_archive WHERE task_id = ${taskId}`
      if (archive === undefined) {
        return null
      }
      const rows = await decodeArchive({ ...archive, chunks: JSON.parse(archive.chunks) as ChunkRef[] })
      await insertRows(tx, taskId, rows)
      await tx`DELETE FROM task_archive WHERE task_id = ${taskId}`
      await tx`UPDATE task SET archived_at = NULL WHERE id = ${taskId}`
      await tx`UPDATE ea_doc SET archived = 0 WHERE task_id = ${taskId}`
      return { rows: rows.length }
    }),
  get: async (taskId: string): Promise<ArchiveRecord | undefined> => {
    const [row] = await sql<ArchiveRow[]>`SELECT ${INFO} FROM task_archive WHERE task_id = ${taskId}`
    return row && toRecord(row)
  },
  list: async (): Promise<Map<string, ArchiveRecord>> =>
    new Map((await sql<ArchiveRow[]>`SELECT ${INFO} FROM task_archive`).map((row) => [row.task_id, toRecord(row)])),
  /** One compressed chunk; the blob is stored uncompressed by PostgreSQL, so this reads a slice. */
  chunk: async (taskId: string, ref: ChunkRef): Promise<Buffer | undefined> =>
    (
      await sql<{ bytes: Buffer }[]>`SELECT substring(blob FROM ${ref.offset + 1} FOR ${ref.length}) AS bytes
        FROM task_archive WHERE task_id = ${taskId}`
    ).at(0)?.bytes,
  setWorktrees: async (taskId: string, worktrees: readonly ArchivedWorktree[]) => {
    await sql`UPDATE task_archive SET worktrees = ${JSON.stringify(worktrees)} WHERE task_id = ${taskId}`
  },
  setFiles: async (taskId: string, files: TaskFilesBundle) => {
    await sql`UPDATE task_archive SET files = ${JSON.stringify(files)} WHERE task_id = ${taskId}`
  },
  totals: async () =>
    (
      await sql<{ count: number; stored_bytes: number; table_bytes: number; files_bytes: number }[]>`SELECT
          COUNT(*)::int AS count, COALESCE(SUM(stored_bytes), 0)::bigint AS stored_bytes,
          COALESCE(SUM(table_bytes), 0)::bigint AS table_bytes,
          COALESCE(SUM((files::jsonb ->> 'bytes')::bigint), 0)::bigint AS files_bytes
        FROM task_archive`
    ).at(0) ?? { count: 0, stored_bytes: 0, table_bytes: 0, files_bytes: 0 },
}

interface SettingsRow {
  auto_enabled: number
  auto_days: number
  delete_after_days: number | null
  resume_after_restart: boolean
  repeat_guard: boolean
  updated_at: string
}

export const archiveSettings = {
  get: async (): Promise<AutoArchiveSettings> => {
    const [row] = await sql<SettingsRow[]>`SELECT auto_enabled, auto_days, delete_after_days, resume_after_restart,
      repeat_guard, updated_at FROM archive_settings WHERE id = 1`
    return row === undefined
      ? { ...AUTO_ARCHIVE_DEFAULTS, updated_at: null }
      : {
          enabled: row.auto_enabled === 1,
          days: row.auto_days,
          delete_after_days: row.delete_after_days,
          resume_after_restart: row.resume_after_restart,
          repeat_guard: row.repeat_guard,
          updated_at: row.updated_at,
        }
  },
  set: async (input: Omit<AutoArchiveSettings, 'updated_at'>): Promise<AutoArchiveSettings> => {
    const at = now()
    await sql`INSERT INTO archive_settings (id, auto_enabled, auto_days, delete_after_days, resume_after_restart,
        repeat_guard, updated_at)
      VALUES (1, ${input.enabled ? 1 : 0}, ${input.days}, ${input.delete_after_days}, ${input.resume_after_restart},
        ${input.repeat_guard}, ${at})
      ON CONFLICT (id) DO UPDATE SET auto_enabled = excluded.auto_enabled, auto_days = excluded.auto_days,
        delete_after_days = excluded.delete_after_days, resume_after_restart = excluded.resume_after_restart,
        repeat_guard = excluded.repeat_guard, updated_at = excluded.updated_at`
    return { ...input, updated_at: at }
  },
}
