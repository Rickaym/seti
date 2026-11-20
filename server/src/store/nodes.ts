import type { JournalCursor } from '@seti/shared'
import { now, sql } from '../db.js'

const DAY_MS = 24 * 60 * 60_000

export const nodeCursors = {
  get: async (taskId: string): Promise<JournalCursor | undefined> => {
    const [row] = await sql<{ epoch: string; seq: string }[]>`SELECT epoch, seq FROM node_cursor
      WHERE task_id = ${taskId}`
    return row === undefined ? undefined : { epoch: row.epoch, seq: Number(row.seq) }
  },
  all: async (): Promise<Record<string, JournalCursor>> => {
    const rows = await sql<{ task_id: string; epoch: string; seq: string }[]>`SELECT task_id, epoch, seq
      FROM node_cursor`
    return Object.fromEntries(rows.map((row) => [row.task_id, { epoch: row.epoch, seq: Number(row.seq) }]))
  },
  set: async (taskId: string, cursor: JournalCursor): Promise<void> => {
    await sql`INSERT INTO node_cursor (task_id, epoch, seq, updated_at)
      VALUES (${taskId}, ${cursor.epoch}, ${cursor.seq}, ${now()})
      ON CONFLICT (task_id) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq,
        updated_at = excluded.updated_at`
  },
}

/** Answers to the node's asks, kept a day so a retried ask gets the same answer. */
export const nodeAsks = {
  get: async (id: string): Promise<string | undefined> =>
    (await sql<{ reply: string }[]>`SELECT reply FROM node_ask WHERE id = ${id}`)[0]?.reply,
  put: async (id: string, reply: string): Promise<void> => {
    await sql`INSERT INTO node_ask (id, reply, created_at) VALUES (${id}, ${reply}, ${now()})
      ON CONFLICT (id) DO NOTHING`
  },
  prune: async (at = Date.now()): Promise<void> => {
    await sql`DELETE FROM node_ask WHERE created_at < ${new Date(at - DAY_MS).toISOString()}`
  },
}

/** The boot id each node last said hello with; a new one means its sessions ended. */
export const nodeBoots = {
  swap: async (nodeId: string, bootId: string): Promise<string | undefined> => {
    const [row] = await sql<{ boot_id: string }[]>`SELECT boot_id FROM node_boot WHERE node_id = ${nodeId}`
    await sql`INSERT INTO node_boot (node_id, boot_id, seen_at) VALUES (${nodeId}, ${bootId}, ${now()})
      ON CONFLICT (node_id) DO UPDATE SET boot_id = excluded.boot_id, seen_at = excluded.seen_at`
    return row?.boot_id
  },
}
