import type { PrInput } from '@seti/shared'
import { sql } from '../db.js'

/** The updates held for one subagent's PRs, and when the oldest of them was held. */
export interface HeldGroup {
  task_id: string
  tool_use_id: string
  since: string
}

/** One held update and its row id, which drops it once it went out. */
export interface HeldInput {
  id: number
  input: PrInput
}

export const prHeld = {
  hold: async (taskId: string, toolUseId: string, inputs: readonly PrInput[], at: string): Promise<void> => {
    for (const input of inputs) {
      await sql`INSERT INTO pr_held_input (task_id, tool_use_id, payload, held_at)
        VALUES (${taskId}, ${toolUseId}, ${JSON.stringify(input)}, ${at})`
    }
  },
  /** Every subagent with held updates, oldest hold first. */
  groups: async (): Promise<HeldGroup[]> => [
    ...(await sql<HeldGroup[]>`SELECT task_id, tool_use_id, MIN(held_at) AS since FROM pr_held_input
      GROUP BY task_id, tool_use_id ORDER BY since`),
  ],
  /** The updates held for the subagent, oldest first. */
  of: async (taskId: string, toolUseId: string): Promise<HeldInput[]> =>
    (
      await sql<{ id: number; payload: string }[]>`SELECT id, payload FROM pr_held_input
        WHERE task_id = ${taskId} AND tool_use_id = ${toolUseId} ORDER BY id`
    ).map((row) => ({ id: row.id, input: JSON.parse(row.payload) as PrInput })),
  drop: async (ids: readonly number[]): Promise<void> => {
    await sql`DELETE FROM pr_held_input WHERE id = ANY(${[...ids]})`
  },
}
