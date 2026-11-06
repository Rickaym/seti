import { sql } from '../db.js'

/** A one-shot wait for an agent's turn to end; a null waiter is the EA. */
export interface AgentWait {
  id: number
  waiter_id: string | null
  target_id: string
  created_at: string
}

export const agentWaits = {
  /** Records the wait, or returns the one the waiter already has on that agent. */
  add: async (waiterId: string | null, targetId: string, at: string): Promise<AgentWait> => {
    const [added] = await sql<AgentWait[]>`INSERT INTO agent_wait (waiter_id, target_id, created_at)
      VALUES (${waiterId}, ${targetId}, ${at}) ON CONFLICT DO NOTHING RETURNING *`
    const [existing] = await sql<AgentWait[]>`SELECT * FROM agent_wait
      WHERE COALESCE(waiter_id, '') = ${waiterId ?? ''} AND target_id = ${targetId}`
    const wait = added ?? existing
    if (wait === undefined) {
      throw new Error('The wait was not recorded')
    }
    return wait
  },
  /** How many waits the waiter has pending. */
  count: async (waiterId: string | null): Promise<number> =>
    (
      await sql<{ count: number }[]>`SELECT COUNT(*) AS count FROM agent_wait
        WHERE COALESCE(waiter_id, '') = ${waiterId ?? ''}`
    ).at(0)?.count ?? 0,
  /** Whether the EA waits for the agent's turn to end. */
  eaWaits: async (targetId: string): Promise<boolean> =>
    (await sql`SELECT 1 FROM agent_wait WHERE waiter_id IS NULL AND target_id = ${targetId}`).length > 0,
  /** The agents whose turn end the EA waits for. */
  eaTargets: async (): Promise<string[]> =>
    (await sql<{ target_id: string }[]>`SELECT target_id FROM agent_wait WHERE waiter_id IS NULL`).map(
      (row) => row.target_id,
    ),
  /** Removes and returns every wait on the agent, so each is delivered once. */
  take: async (targetId: string): Promise<AgentWait[]> => [
    ...(await sql<AgentWait[]>`DELETE FROM agent_wait WHERE target_id = ${targetId} RETURNING *`),
  ],
  remove: async (id: number): Promise<void> => {
    await sql`DELETE FROM agent_wait WHERE id = ${id}`
  },
  /** Drops the waits by or on the agent; returns how many. */
  cancelFor: async (taskId: string): Promise<number> =>
    (await sql`DELETE FROM agent_wait WHERE waiter_id = ${taskId} OR target_id = ${taskId}`).count,
}
