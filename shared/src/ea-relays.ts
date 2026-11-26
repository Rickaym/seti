import { z } from 'zod'
import type { TeamDeliveryMode } from './team.js'

/** The longest message the EA may relay; a relay is a gist and a next step, never a copy. */
export const EA_RELAY_TEXT_MAX = 400

/** A run of this many words copied from the item makes a relay a quote, which Seti refuses. */
export const EA_RELAY_COPY_WORDS = 8

/** Relays per agent and in all within one window, so untrusted items cannot flood agents. */
export const EA_RELAY_LIMITS = { perAgent: 2, all: 8, windowMs: 60 * 60_000 } as const

/** The user's switch for inbox relays; only the user turns it on or off. */
export const eaRelaySwitchInput = z.object({ on: z.boolean() })

/** The EA passes an inbox item to the agent it is about, in its own words. */
export const eaRelayInput = z.object({
  item_id: z.number().int().positive(),
  /** The agent's task id or group chat handle. */
  to: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(EA_RELAY_TEXT_MAX),
})
export type EaRelayInput = z.output<typeof eaRelayInput>

/** A relay the EA sent; Take back works while `pending`, before the agent has read it. */
export interface EaRelay {
  id: number
  item_id: number | null
  task_id: string | null
  /** The agent's title as it was when the relay went. */
  title: string
  message_id: number | null
  mode: TeamDeliveryMode
  pending: boolean
  taken_back: boolean
  created_at: string
}
