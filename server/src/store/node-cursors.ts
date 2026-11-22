import { now, sql } from '../db.js'

/** Where the control plane stands in one agent's node journal: epoch and last applied number. */
export interface NodeCursor {
  agent: string
  epoch: string
  seq: number
}

export const nodeCursors = {
  /** Every agent's cursor, which the control plane takes up from as a node connects. */
  list: async (): Promise<NodeCursor[]> => sql<NodeCursor[]>`SELECT agent, epoch, seq FROM node_cursor`,
  /** Records that the agent's entries are applied up to `seq` of the journal `epoch`. */
  save: async ({ agent, epoch, seq }: NodeCursor): Promise<void> => {
    await sql`INSERT INTO node_cursor (agent, epoch, seq, at) VALUES (${agent}, ${epoch}, ${seq}, ${now()})
      ON CONFLICT (agent) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq, at = excluded.at`
  },
}
