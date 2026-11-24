import type { ApprovalCeiling } from '../approval-ceiling.js'
import { sql } from '../db.js'

/** The approval ceiling an agent got from the agent that started it; null for none. */
export const approvalCeilings = {
  get: async (taskId: string): Promise<ApprovalCeiling | null> => {
    const [row] = await sql<{ approval_ceiling: string | null }[]>`SELECT approval_ceiling FROM task
      WHERE id = ${taskId}`
    return row?.approval_ceiling === 'codex' ? 'codex' : null
  },
  set: async (taskId: string, ceiling: ApprovalCeiling): Promise<void> => {
    await sql`UPDATE task SET approval_ceiling = ${ceiling} WHERE id = ${taskId}`
  },
}
