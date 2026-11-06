import type { RewindRestore, RewindState, TaskRewind } from '@seti/shared'
import { now, sql, transaction } from '../db.js'

export interface PendingRewind {
  id: number
  /** Last chain entry to keep; null starts a new session. */
  resume_at: string | null
  /** Prompt uuid of the one turn the resume drops, when exactly one turn is dropped. */
  drops_turn: string | null
}

export interface NewRewind {
  task_id: string
  prompt_message_id: number
  last_message_id: number
  message_count: number
  prompt_text: string
  restore: RewindRestore
  state: RewindState
  resume_at: string | null
  drops_turn: string | null
  files_changed: string[]
}

export interface RewindRow {
  id: number
  kind: string
  created_at: string
  text: string | null
  /** Where a prompt sent during a turn went, or null for one that started its turn. */
  queued: string | null
  type: string | null
  uuid: string | null
  session_id: string | null
  sidechain: number
}

type RewindRecord = Omit<TaskRewind, 'files_changed'> & { files_changed: string }

const COLUMNS = sql`id, task_id, prompt_message_id, last_message_id, message_count, prompt_text, restore, state,
  reason, files_changed, created_at`

const toRewind = (record: RewindRecord): TaskRewind => ({
  ...record,
  files_changed: JSON.parse(record.files_changed) as string[],
})

export const rewinds = {
  /** Records a rewind; a new pending one replaces any earlier pending one. */
  insert: async (rewind: NewRewind): Promise<TaskRewind> =>
    transaction(async (tx) => {
      if (rewind.state === 'pending') {
        await tx`UPDATE task_rewind SET state = 'superseded' WHERE task_id = ${rewind.task_id} AND state = 'pending'`
      }
      const [record] = await tx<RewindRecord[]>`INSERT INTO task_rewind (task_id, prompt_message_id, last_message_id,
          message_count, prompt_text, restore, state, resume_at, drops_turn, files_changed, created_at)
        VALUES (${rewind.task_id}, ${rewind.prompt_message_id}, ${rewind.last_message_id}, ${rewind.message_count},
          ${rewind.prompt_text}, ${rewind.restore}, ${rewind.state}, ${rewind.resume_at}, ${rewind.drops_turn},
          ${JSON.stringify(rewind.files_changed)}, ${now()})
        RETURNING ${COLUMNS}`
      if (!record) {
        throw new Error('Rewind was not recorded')
      }
      return toRewind(record)
    }),
  list: async (taskId: string) =>
    (await sql<RewindRecord[]>`SELECT ${COLUMNS} FROM task_rewind WHERE task_id = ${taskId} ORDER BY id`).map(toRewind),
  pending: async (taskId: string) =>
    (
      await sql<PendingRewind[]>`SELECT id, resume_at, drops_turn FROM task_rewind
        WHERE task_id = ${taskId} AND state = 'pending' ORDER BY id DESC`
    ).at(0),
  /** Marks the rewind a turn started from as applied, or as refused by Claude Code. */
  settle: async (id: number, state: 'applied' | 'refused', reason: string | null = null) => {
    await sql`UPDATE task_rewind SET state = ${state}, reason = ${reason}
      WHERE id = ${id} AND state IN ('pending', 'applied')`
  },
  rows: async (taskId: string) => [
    ...(await sql<RewindRow[]>`SELECT id, kind, created_at,
        CASE WHEN kind = 'prompt' THEN payload::json ->> 'text' END AS text,
        CASE WHEN kind = 'prompt' THEN payload::json ->> 'queued' END AS queued,
        CASE WHEN kind = 'sdk' THEN payload::json ->> 'type' END AS type,
        CASE WHEN kind = 'sdk' THEN payload::json ->> 'uuid' END AS uuid,
        CASE WHEN kind = 'sdk' THEN payload::json ->> 'session_id' END AS session_id,
        CASE WHEN kind = 'sdk' AND ((payload::json ->> 'parent_tool_use_id') IS NOT NULL
          OR COALESCE(payload::json ->> 'isReplay', 'false') = 'true') THEN 1 ELSE 0 END AS sidechain
      FROM task_message WHERE task_id = ${taskId} ORDER BY id`),
  ],
}
