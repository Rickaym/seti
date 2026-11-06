import { z } from 'zod'

/** The ops a mod can only ask for: the user's Allow runs them, never the mod itself. */
export type ModAskOp = 'tasks.manage.start' | 'tasks.manage.stop'

const MOD_ASK_DECISIONS = ['allow', 'deny'] as const
export type ModAskDecision = (typeof MOD_ASK_DECISIONS)[number]

/** Where an ask stands: open, past its time, answered, or allowed and then run. */
export type ModAskState = 'pending' | 'expired' | 'allowed' | 'denied' | 'done' | 'failed'

/** One thing a mod asked the user to allow, with the summary Seti wrote, never the mod. */
export interface ModAsk {
  id: string
  mod_id: string
  op: ModAskOp
  summary: string
  /** The whole prompt or target the Allow runs, for the sheet that shows it. */
  args: Record<string, unknown>
  created_at: string
  expires_at: string
  state: ModAskState
  decided_at: string | null
  /** What the Allow did, such as the new agent's id, or why it failed. */
  outcome: string | null
}

export const modAskParams = z.strictObject({ id: z.uuid() })

export const modAskDecisionInput = z.strictObject({ decision: z.enum(MOD_ASK_DECISIONS) })
